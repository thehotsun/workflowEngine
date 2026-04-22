# Workflow Engine 架构与演进说明（task.md）

> 版本：v1.4+
> 定位：长期维护文档（目标 / 架构 / 接口 / 机制 / 约束 / 优化路线）
> 原则：只保留长期有效信息，不记录一次性 bug 修复流水账。

---

## 一、文档边界

### 1.1 本文档包含

- 项目目标与系统边界
- 架构总览与端到端链路
- 目录结构与模块职责
- 核心 Interface / 契约定义
- 执行模型（状态机、重试、超时、恢复）
- Schema 设计说明（表用途、关键字段、约束、索引）
- RAG 机制与降级路径
- 可观测性、日志、指标建议
- 配置约束与长期优化路线

### 1.2 本文档不包含

- 部署命令、安装排障步骤（统一见 `DEPLOY.md`）
- 临时排障过程记录
- 与当前架构无关的阶段性任务列表

### 1.3 维护原则

1. 架构、接口、机制变化后必须同步更新本文档。
2. 新增优化项必须包含：目标、范围、验收标准。
3. 数据库 DDL 以 `persist/schema.sql` 为唯一技术源，本文只解释设计意图。
4. 本文中的行为描述以代码实现为准，避免“文档先于代码”漂移。

---

## 二、项目目标与系统边界

### 2.1 项目目标

构建一个可插拔的 AI 工作流引擎，具备以下能力：

1. **解耦集成**：通过 HTTP/Webhook 与 OpenClaw 解耦。
2. **声明式编排**：以 workflow 定义 step 顺序、条件分支、并行容器。
3. **可靠执行**：基于持久化实现幂等、重试、DLQ、断点恢复。
4. **RAG 支持**：本地 Markdown 增量导入 + 向量检索 + 文本降级。
5. **可运维**：并发控制、日志、定时调度、健康检查。

### 2.2 系统边界

- 本系统负责：事件接入、流程匹配与执行、状态持久化、消息出站、RAG。
- OpenClaw 负责：渠道接入、插件与工具执行生态。
- 模型服务由百炼（OpenAI 兼容协议）提供，路由层预留多模型扩展位。

### 2.3 非目标（当前版本）

- 不内置复杂权限平台（仅 webhook/gateway token 鉴权）。
- 不提供图形化编排器（以代码定义 workflow）。
- 不内置全套指标面板（目前以结构化日志 + DB 统计为主）。

---

## 三、架构总览

### 3.1 端到端主链路（消息触发）

```text
my-qq-filter（OpenClaw 插件）
  -> message_received hook 触发
  -> POST /events/openclaw（转发到工作流引擎）
  -> verifyWebhookAuth + normalizeWebhookPayload
  -> shouldProcessMessage 拦截器检查（webhook 层，复用 workflow trigger.match）
      - 不匹配任何流程触发条件 -> 返回 eventId: null -> openclaw 自行回复
      - 匹配 -> 继续
  -> createEvent -> event_inbox (pending)
  -> 返回 eventId（非 null）-> my-qq-filter 阻止 openclaw 默认回复
  -> pollEvents() 拉取并发消费
  -> WorkflowEngine.handleEvent
      - shouldProcessMessage 兜底检查（兼容 /events/manual 等非 webhook 来源）
      - matchWorkflow 流程匹配（与拦截器共用同一套 trigger.match）
  -> workflow_runs / step_runs 持久化
  -> publish.step 写 message_outbox
  -> outbox-worker (事件驱动 + 轮询兜底)
  -> openclaw/client.js 直接调用 QQ Bot API（c2c / group）
  -> 下游渠道（QQ 等）
```

### 3.2 RAG 侧链路

```text
knowledge/**/*.md
  -> rag/ingest.js 递归扫描
  -> sha256 增量判断
  -> chunkMarkdown 分块
  -> embedding 批量生成
  -> knowledge_docs / knowledge_chunks / knowledge_vectors
  -> rag/retriever.js
      (vector recall -> BM25 rerank -> topK)
      (fallback: textSearch)
```

### 3.3 启动与恢复链路

```text
index.js start()
  -> engine.recoverRuns() 恢复 pending/running/retrying
  -> 启动 Fastify HTTP
  -> setInterval(pollEvents)
  -> startOutboxWorker()
  -> startScheduler()
```

### 3.4 关键运行特征

- 事件消费采用”轮询 + 批并发 + 进程内互斥锁（isProcessing）”。
- step 执行采用”串行调度 + 每步独立持久化 + 重试/超时保护”。
- 出站发送采用”直接调用 QQ Bot API”（c2c 私聊 / group 群聊），不再经过 OpenClaw `/tools/invoke`。
- 恢复逻辑按 `step_index` 计算续跑位点，避免重复执行已完成步骤。

### 3.5 消息拦截器机制

拦截器逻辑由 `core/engine.js` 的 `buildInterceptor(workflows)` 工厂生成，在 `WorkflowEngine` 构造时绑定为实例方法 `engine.shouldProcessMessage`，**复用各 workflow 的 `trigger.match` 作为白名单**，不单独维护关键词列表。

**判断逻辑**：消息能被任意一个已注册 workflow 的 `trigger.match` 匹配 → 放行；否则 → 交还 openclaw 自行回复。

| 调用层 | 位置 | 时机 | 作用 |
|---|---|---|---|
| webhook 层（主路径） | `trigger/webhook.js` createEvent 前 | 同步，入库前 | 不通过返回 `eventId: null`，my-qq-filter 不阻止 openclaw 回复 |
| 引擎层（兜底） | `core/engine.js` handleEvent 前 | 异步轮询后 | 覆盖 `/events/manual` 等非 webhook 来源 |

**扩展方式**：新增 workflow 并在 `index.js` 注册后，拦截器自动从其 `trigger.match` 中派生匹配规则，无需改动 engine.js。时间过滤、用户白名单等扩展规则可在 `buildInterceptor` 内追加。

---

## 四、项目目录结构与模块职责（详细）

```text
workflow-engine/
├── index.js                       # 程序入口：恢复、HTTP、轮询、outbox、scheduler
├── config/
│   └── index.js                   # 环境变量读取与默认值
├── core/
│   ├── engine.js                  # 工作流核心：拦截器配置、匹配、run/step 执行、恢复、onError
│   ├── dispatcher.js              # step 顺序调度器
│   ├── retry.js                   # 指数退避重试 + DLQ 入队
│   ├── state-machine.js           # workflow run 状态流转校验
│   └── context.js                 # WorkflowContext（get/set/merge/has/snapshot）
├── steps/
│   ├── base.step.js               # Step 抽象接口
│   ├── index.js                   # Step 注册中心（buildStep/registerStep）
│   ├── parallel.step.js           # 并行子步骤容器
│   ├── conditional.step.js        # 条件分支执行器
│   ├── transform.step.js          # 数据变换
│   ├── noop.step.js               # 空操作
│   ├── skill-proxy.step.js        # 工具代理
│   ├── rag-query.step.js          # RAG 查询
│   ├── topic.step.js              # 主题提炼
│   ├── hotspot.step.js            # 热点提炼
│   ├── write.step.js              # 内容生成
│   ├── polish.step.js             # 文本润色
│   └── publish.step.js            # 发送（写入 outbox 并触发 worker）
├── models/
│   ├── base.model.js              # Model 抽象接口
│   ├── bailian.model.js           # 百炼模型实现（chat/embedding）
│   ├── openai-compat.model.js     # OpenAI 兼容封装
│   └── router.js                  # taskType -> model 路由
├── openclaw/
│   ├── adapter.js                 # webhook payload 标准化 + 鉴权
│   ├── client.js                  # QQ Bot API 直接发送（c2c / group）+ 熔断器
│   ├── session-mapper.js          # source/channel/user -> conversation
│   └── hooks/
│       └── my-qq-filter.js        # OpenClaw 插件：转发消息 + 根据 eventId 阻止默认回复
├── rag/
│   ├── chunker.js                 # Markdown 分块
│   ├── embedder.js                # embedding 调用封装
│   ├── ingest.js                  # 增量导入 CLI
│   ├── store.js                   # 向量/文本检索存取
│   └── retriever.js               # 召回 + BM25 重排 + 降级
├── persist/
│   ├── db.js                      # SQLite 初始化（WAL、sqlite-vec、schema）
│   ├── schema.sql                 # 全量 DDL
│   └── repos/
│       ├── event.repo.js          # event_inbox 读写
│       ├── workflow.repo.js       # workflow_runs 读写
│       ├── step.repo.js           # step_runs 读写
│       ├── conversation.repo.js   # conversations 读写
│       ├── outbox.repo.js         # message_outbox 读写
│       ├── dlq.repo.js            # dlq 读写
│       └── knowledge.repo.js      # knowledge_* 读写
├── trigger/
│   ├── webhook.js                 # /events/openclaw（含拦截器检查） /events/manual /health
│   ├── outbox-worker.js           # 发送 worker（事件驱动 + 轮询）
│   └── scheduler.js               # cron 触发 + WAL checkpoint
├── workflows/
│   ├── article.flow.js            # 默认启用流程
│   └── analysis.flow.js           # 已实现，入口默认未启用
├── utils/
│   └── logger.js                  # pino 封装
├── knowledge/                     # 默认知识库语料目录（.md）
├── DEPLOY.md                      # 部署与安装排障
└── task.md                        # 架构与演进文档（本文）
```

---

## 五、核心 Interface 与契约定义（详细）

## 5.1 Step Interface（`steps/base.step.js`）

```js
class BaseStep {
  get name() {}
  get retryable() { return true }
  get timeout() { return 30_000 }
  get requires() { return [] }
  get provides() { return [] }
  async execute(context, stepDef) {}
}
```

### 约束与语义

- `name`：进入 `step_runs.step_name` 与日志标识。
- `retryable`：若 `false`，运行时会将 `maxRetries` 强制为 0。
- `timeout`：默认超时；可被 `stepDef.timeout` 覆盖。
- `requires`：声明 context 前置依赖；执行前强校验，缺失即输入错误。
- `provides`：文档语义字段，用于流程设计核对。
- `execute(context, stepDef)`：返回 `{ ok, output, usage? }`。

### 输出写入规则（engine 统一处理）

1. 若配置 `stepDef.output`：将 `result.output` 写入该单键。
2. 否则当 `result.output` 为对象：`context.merge(result.output)`。
3. 非对象输出且未配置 `stepDef.output`：不自动落 context。

## 5.2 WorkflowContext Interface（`core/context.js`）

```js
class WorkflowContext {
  get(key, defaultValue)
  set(key, value)
  delete(key)
  merge(patch)
  has(key)
  snapshot()
  toJSON()
}
```

### 约束与语义

- `has(key)` 使用 `hasOwnProperty`，区分“键不存在”和“值为 undefined/null”。
- `snapshot()` 生成拷贝上下文，供并行子步骤隔离使用。
- `toJSON()` 结果用于 `workflow_runs.context_json` 持久化。

## 5.3 Workflow Definition Interface（`workflows/*.flow.js`）

```js
module.exports = {
  id: 'article_flow',
  name: '公众号文章生成',
  trigger: { type: 'message', match: /.../ },
  steps: [
    { type: 'topic' },
    { type: 'rag-query', input: ctx => ({ query: ctx.get('topic') }), output: 'ragResults', topK: 5 },
    { type: 'conditional', condition: ctx => true, ifTrue: {...}, ifFalse: {...} },
    { type: 'write' },
    { type: 'polish' },
    { type: 'publish' }
  ],
  onError: 'notify-and-dlq'
}
```

### 约束与语义

- `trigger.type` 与事件 `triggerType` 精确匹配。
- `trigger.match` 当前要求为可执行 `RegExp`。
- `steps[*].type` 必须在 `steps/index.js` 注册。
- `onError` 当前实现策略为 `notify-and-dlq`。

## 5.4 InternalEvent Interface（`openclaw/adapter.js` 标准化输出）

```js
{
  eventId: string | null,
  source: 'openclaw' | 'manual' | 'schedule' | string,
  sourceEventId: string | null,
  triggerType: string,
  userId: string | null,
  channelId: string | null,
  text: string,
  metadata: {
    rawPayload: object,
    receivedAt: number,
    qqEventType: string | null,
    hookEvent: string | null,
    sessionKey: string | null,
    action: string | null,
    routeId: string | null,
    sessionId: string | null,
    flowId: string | null,
    taskId: string | null,
    runtime: string | null
  }
}
```

### 输入兼容格式

1. QQ Bot 原始事件：`{ t, d }`
2. Hook 转发事件：`{ hookEvent, sessionKey, context }`
3. 扁平通用事件：`{ channelId, userId, text, ... }`

## 5.5 Model Interface（`models/base.model.js`）

```js
class BaseModel {
  get name() {}
  async chat(messages, options = {}) {}
  async embedding(text) {}
}
```

### 路由约束（`models/router.js`）

- 通过 `route(taskType)` 选择模型实例。
- 当前 `embedding/writing/analysis/reasoning/fallback` 全部指向 `bailian`。
- 支持运行期 `registerModel` 与 `setRoute` 动态扩展。

## 5.6 OpenClaw 调用 Interface（`openclaw/client.js`）

### 工具调用请求

```json
POST /tools/invoke
{
  "tool": "message",
  "action": "send",
  "args": { "target": "qqbot:c2c:...", "content": "..." },
  "sessionKey": "main",
  "dryRun": false
}
```

### 调用约束

- 请求头可包含 `Authorization: Bearer OPENCLAW_GATEWAY_TOKEN`。
- 可附带 `x-openclaw-message-channel`、`x-openclaw-account-id`。
- 内置熔断器：`closed -> open -> half-open`。
- 超时由 `AbortController` 控制，超时和 HTTP 非 2xx 都计入失败计数。

## 5.7 Repo Interface（持久化边界）

- `event.repo`：createEvent/getPending/markProcessing/markDone/markFailed
- `workflow.repo`：createRun/updateRunStatus/getRunById/getRecoverableRuns
- `step.repo`：createStepRun/updateStepRun/getCompletedStepRuns
- `conversation.repo`：getOrCreateConversation/updateConversation/appendHistory
- `outbox.repo`：enqueue/getPending/markSending/markSent/retry/failed/resetStale
- `dlq.repo`：enqueueDlq
- `knowledge.repo`：文档、分块、向量的增删改查

---

## 六、执行模型与状态流转

## 6.1 Event 处理生命周期

`event_inbox.status`：

`pending -> processing -> done | failed`

- 入站时为 `pending`。
- 引擎创建 run 后标记 `processing`。
- 流程成功后标记 `done`。
- 流程失败或处理异常标记 `failed`。

## 6.2 Workflow Run 状态机

来自 `core/state-machine.js`：

- `pending -> running | failed`
- `running -> done | failed | retrying`
- `retrying -> running | failed`
- `done` 与 `failed` 为终态

引擎在关键状态切换前使用 `assertTransition` 强校验，阻止非法转换。

## 6.3 Step 执行生命周期

`step_runs.status`：

`pending -> running -> done | failed`

每个 step 都会记录：输入、输出、耗时、token 消耗、错误。

## 6.4 Outbox 发送状态机

`message_outbox.status`：

`pending -> sending -> sent | failed`

失败未到上限时回到 `pending` 重试；达到上限进入 `failed`。

## 6.5 重试与超时语义

- `withRetry`：指数退避，默认基准延迟 1000ms。
- `runStep` 传入 `maxRetries`：
  - `step.retryable === false` -> `0`
  - 否则使用 `stepDef.maxRetries ?? 2`
- 输入缺失类错误（`err.isInputError || err.notRetryable`）不重试，直接进入失败流程并写 DLQ。
- `executeWithTimeout` 使用 `Promise.race`：超时抛错 `Step timeout after ...`。

## 6.6 断点恢复语义

`recoverRuns()` 会恢复 `pending/running/retrying` 的 run：

1. 读取 run 的 `context_json` 重建上下文。
2. 查询已完成 step（status=done）。
3. 仅按顶层 `step_index` 计算续跑位点（避免子步骤污染）。
4. 从 `nextIndex` 继续执行到结束。

## 6.7 错误策略语义

`onError: 'notify-and-dlq'` 时：

- run 标记 `failed`。
- event 标记 `failed`。
- 生成告警消息写入 outbox，并触发即时发送。

---

## 七、Schema 设计说明（仅用途与约束，不重复 SQL）

> 完整字段定义、DDL、索引创建语句以 `persist/schema.sql` 为准。

## 7.1 事件与执行域

### `event_inbox`

- 作用：统一事件入口，支持幂等入站与异步消费。
- 关键字段：`source`, `source_event_id`, `event_type`, `payload_json`, `status`。
- 关键约束：`UNIQUE(source, source_event_id)`（幂等核心）。
- 关键索引：`idx_event_inbox_status`（pending 扫描加速）。

### `workflow_runs`

- 作用：一次 workflow 实例的主记录。
- 关键字段：`workflow_id`, `conversation_id`, `event_id`, `status`, `context_json`, `current_step`, `error`。
- 关键作用：支撑状态机校验、恢复、审计、故障归因。
- 关键索引：`idx_runs_status`。

### `step_runs`

- 作用：step 粒度执行轨迹。
- 关键字段：`step_name`, `step_index`, `status`, `input_json`, `output_json`, `retry_count`, `duration_ms`, `token_used`。
- 关键作用：性能分析、成本核算、问题定位。
- 关键索引：`idx_step_runs_run`。

## 7.2 会话域

### `conversations`

- 作用：多轮上下文存储（含历史摘要）。
- 关键字段：`source`, `channel_id`, `user_id`, `context_json`, `last_run_id`。
- 关键约束：`UNIQUE(source, channel_id)` 保证同源同频道唯一会话。

## 7.3 消息可靠性域

### `message_outbox`

- 作用：Outbox 可靠发送缓冲区。
- 关键字段：`channel_id`, `content`, `status`, `retry_count`, `created_at`, `sent_at`。
- 关键作用：实现“先持久化后发送”，支撑失败重试与可追溯。
- 关键索引：`idx_outbox_status`。

### `dlq`

- 作用：承接重试耗尽或不可重试失败。
- 关键字段：`run_id`, `step_name`, `error`, `input_json`, `retry_count`, `replayed_at`。
- 关键作用：人工排障、后续自动重放策略基础。

## 7.4 知识库域

### `knowledge_docs`

- 作用：文档级元信息（路径、hash、状态、统计）。
- 关键字段：`file_path`（唯一）、`file_hash`, `status`, `chunk_count`, `indexed_at`。
- 关键作用：增量导入、删除同步、重建判断。

### `knowledge_chunks`

- 作用：文档分块存储。
- 关键字段：`doc_id`, `chunk_index`, `heading`, `content`, `token_count`。
- 关键索引：`idx_chunks_doc`。

### `knowledge_vectors`（vec0 虚拟表）

- 作用：向量索引与近邻检索。
- 关键字段：`chunk_id`, `embedding float[1024]`。
- 运行依赖：sqlite-vec 扩展加载成功。

## 7.5 DB 运行模式

- `journal_mode=WAL`
- `synchronous=NORMAL`
- `foreign_keys=ON`
- `busy_timeout=5000`
- `cache_size=-32000`（约 32MB）

目标：在可靠性、写入吞吐与恢复能力之间取得平衡。

---

## 八、核心机制评估

## 8.1 Step 约束机制评估

| 机制 | 状态 | 说明 |
|---|---|---|
| 输入依赖校验 | 完整 | `step.requires + stepDef.requires/dependsOn` 执行前强校验 |
| 不可重试输入错误 | 完整 | 缺失依赖会标记 `isInputError/notRetryable`，不做退避重试 |
| 输出落盘规则 | 完整 | `stepDef.output` 定向写入；对象输出自动 merge |
| 超时保护 | 完整 | `executeWithTimeout` + `Promise.race` |
| 重试机制 | 完整 | 指数退避，超限入 DLQ |
| 失败可追踪 | 完整 | `step_runs` 记录 error、duration、token |
| 子步骤索引隔离 | 可用 | 通过 `_currentStepIndex` 保存与恢复，避免父子覆盖 |

## 8.2 可靠性机制评估

- **事件幂等**：应用层重复检查 + DB 唯一约束双保险。
- **发送可靠性**：Outbox + 重试 + 失败沉淀。
- **进程恢复**：重启后扫描 recoverable run，按位点续跑。
- **失败可见性**：event/run/step/DLQ 四层可追踪。

## 8.3 并发与限流机制评估

- 事件并发：`MAX_CONCURRENT_RUNS` 控制每轮消费数量。
- LLM 并发：`MAX_CONCURRENT_LLM_CALLS`（在模型层/调用层配合）。
- Embedding 并发：`MAX_CONCURRENT_EMBED_CALLS`。
- Embedding 批量：单批不超过 10（由模型实现控制）。

## 8.4 RAG 机制评估

- 增量 ingest：按 `file_hash` 跳过未变更文档。
- 更新策略：文档变化时先删旧 chunks/vectors 后重建。
- 检索主路径：向量召回 + BM25 重排融合。
- 降级策略：向量不可用 / embedding 异常 / 召回为空 -> text search。

## 8.5 调度与运维机制评估

- outbox-worker：事件驱动（低延迟）+ 轮询兜底（抗丢事件）。
- 启动修复：重置“卡死 sending”消息到 pending。
- scheduler：业务 cron + 每日 WAL checkpoint。
- `/health`：当前为存活检查，后续可扩展深度探测。

---

## 九、关键链路时序（简版）

## 9.1 入站到执行

1. webhook 鉴权通过后，payload 标准化。
2. `createEvent` 入 `event_inbox(pending)`。
3. `pollEvents` 批量读取 pending。
4. 每条事件映射会话并创建 run。
5. run -> running，按 step 顺序执行。
6. 成功：run done + event done；失败：run failed + event failed。

## 9.2 发布与出站

1. publish step 写 `message_outbox(pending)`。
2. `outboxEmitter` 触发即时消费。
3. worker 标记 sending，调用 OpenClaw。
4. 成功 sent；失败按重试策略回 pending 或入 failed。

## 9.3 恢复

1. 进程启动扫描 recoverable runs。
2. 重建 context 与 conversation。
3. 计算 next step index。
4. 从断点续跑并完成状态收敛。

---

## 十、配置与运行约束（摘要）

> 详细部署与示例见 `DEPLOY.md`。

### 10.1 模型配置

- `BAILIAN_API_KEY`
- `BAILIAN_BASE_URL`
- `BAILIAN_CHAT_MODEL`
- `BAILIAN_EMBED_MODEL`

### 10.2 OpenClaw 配置

- `OPENCLAW_BASE_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_WEBHOOK_SECRET`
- `OPENCLAW_DEFAULT_SESSION_KEY`
- `OPENCLAW_MESSAGE_*`
- `OPENCLAW_ACCOUNT_ID`

### 10.3 存储与知识库

- `DB_PATH`
- `KNOWLEDGE_DIR`

### 10.4 并发与熔断

- `MAX_CONCURRENT_RUNS`
- `MAX_CONCURRENT_LLM_CALLS`
- `MAX_CONCURRENT_EMBED_CALLS`
- `CIRCUIT_BREAKER_THRESHOLD`
- `CIRCUIT_BREAKER_RESET_MS`

### 10.5 调度

- `SCHEDULER_CRON`
- `SCHEDULER_CHANNEL_ID`
- `SCHEDULER_TEXT`

### 10.6 运行约束

- `/events/openclaw` 与 `/events/manual` 均走 shared-secret 鉴权。
- `/tools/invoke` 调用建议携带 gateway token。
- 默认仅启用 `article_flow`；`analysis_flow` 已实现、入口未默认挂载。

---

## 十一、可观测性与日志优化（详细）

## 11.1 建议事件模型

| 事件名 | 必填字段 | 说明 |
|---|---|---|
| `event.accepted` | `eventId, source, sourceEventId, channelId` | 入站成功 |
| `event.invalid` | `reason, payloadMeta` | 请求无效/鉴权失败 |
| `run.started` | `runId, workflowId, eventId` | run 开始 |
| `run.finished` | `runId, status, durationMs` | run 结束 |
| `step.started` | `runId, stepName, stepIndex` | step 开始 |
| `step.finished` | `runId, stepName, status, durationMs, tokenUsed` | step 结束 |
| `retry.scheduled` | `runId, stepName, retryCount, nextDelayMs` | 安排重试 |
| `outbox.sent` | `msgId, channelId` | 发送成功 |
| `outbox.failed` | `msgId, retryCount, error` | 发送失败 |
| `rag.ingest.file` | `filePath, chunkCount, status` | 语料处理进度 |

## 11.2 日志字段规范

- 关联字段：`traceId`, `eventId`, `runId`, `workflowId`, `stepName`
- 性能字段：`durationMs`, `queueWaitMs`
- 成本字段：`tokenUsed`, `model`
- 错误字段：`errorType`, `errorCode`, `errorMessage`

## 11.3 指标建议

1. run 成功率 / 失败率
2. step 耗时分位数（P50/P95/P99）
3. DLQ 积压量与新增速率
4. outbox 失败率、重试分布
5. token 用量（按 workflow / step 聚合）

---

## 十二、安全与健壮性约束

## 12.1 安全边界

- webhook 路由必须校验密钥（允许 Bearer 或专用 header）。
- OpenClaw 调用需使用 gateway token。
- 仅接受标准化后事件进入执行面，减少脏输入扩散。

## 12.2 健壮性边界

- DB 忙等待（busy timeout）避免瞬时写冲突失败。
- 熔断器保护下游不可用时的放大故障。
- outbox stale sending 恢复机制防止消息永久滞留。
- 失败路径统一沉淀到 run/step/DLQ，避免“静默失败”。

---

## 十三、后期优化路线（持续细化）

## 13.1 P0（高优先级）

1. **健康检查增强**
   - 目标：`/health` 覆盖 DB / OpenClaw / 模型可用性。
   - 范围：增加分项探活与降级状态。
   - 验收：返回 `ok/degraded/down` 与原因明细。

2. **DLQ 自动重放机制**
   - 目标：降低人工干预成本。
   - 范围：按错误类型、时间窗口、重试上限执行重放。
   - 验收：支持策略配置、重放审计、失败回流保护。

## 13.2 P1（中优先级）

1. **Ingest 可观测性增强**
   - 目标：可见文件级与阶段级进度。
   - 范围：扫描、分块、向量化、入库分阶段日志。
   - 验收：输出总量、进度、成功/失败、总耗时。

2. **运行指标聚合输出**
   - 目标：快速判断健康度与成本。
   - 范围：run、step、outbox、DLQ、token 聚合。
   - 验收：提供可查询统计接口或周期报表。

## 13.3 P2（优化项）

1. 检索质量增强：评估引入独立 rerank 模型。
2. 知识库治理：索引审计、语料质量评估、失效清理。
3. workflow 治理：流程启停、灰度策略、动态路由。

---

## 十四、长期有效待办（非流水账）

- [ ] 健康检查深度化（DB/OpenClaw/模型）
- [ ] DLQ 自动重放方案设计与实现
- [ ] ingest 进度日志标准化
- [ ] 统一日志字段规范落地
- [ ] 运行指标聚合与可视化输出
- [ ] analysis_flow 启用策略定义与灰度方案

---

## 十五、文档协同关系

- `DEPLOY.md`：部署步骤、环境准备、安装排障。
- `task.md`（本文）：架构、接口、机制、约束、演进路线。
- `persist/schema.sql`：数据库 DDL 唯一技术源。

> 维护建议：涉及架构、状态机、接口、Schema、流程策略变化的 PR，必须同步更新本文档。

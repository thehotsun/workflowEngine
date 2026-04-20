# 可插拔 AI 工作流引擎 — 完整系统方案

> 版本：v1.3
> 日期：2026-04-20
> 角色：系统架构师设计文档

---

## ⚙️ 协作规范

### 代码与文档同步原则

> **任何代码级别的修改，必须同步更新本 md 文件。**
>
> - 新增/删除/重构文件 → 更新"三、项目目录结构"和"十五、已完成与未完成"
> - 修改接口/数据结构/流程 → 更新对应章节的说明
> - 完成代办事项 → 将 `[ ]` 改为 `[x]`，并在已完成列表中补充描述
> - 新增代办事项 → 直接追加到对应优先级分组
>
> 本文档是项目唯一的权威架构说明，代码与文档必须保持一致。

### 开发环境说明

> 当前为**纯开发环境**，不需要安装任何 npm 依赖。
> 所有代码改动只需保证**逻辑流程可跑通**（`node --check` 语法通过）即可，
> 运行时依赖（`better-sqlite3`、`fastify`、`pino` 等）在部署阶段统一安装。

---

## 一、项目目标

构建一个**可插拔 AI 工作流引擎**，核心目标如下：

- 以 OpenClaw 为消息入口和 Skill 执行层
- 工作流引擎作为独立服务，通过 HTTP 与 OpenClaw 解耦
- 直连阿里云百炼模型，保留多模型扩展能力
- 内置增量知识库（RAG），默认语料为 Markdown 文件
- 状态全量持久化，支持断点续跑
- Step 完全插件化，Skill 通过通用代理层复用 OpenClaw 生态

---

## 二、整体架构

```
┌────────────────────────────────────────────────────────────┐
│                    QQBot (腾讯频道/群)                      │
└──────────────────────────┬─────────────────────────────────┘
                           │ 消息
┌──────────────────────────▼──────────────────────────────────┐
│                  OpenClaw Runtime (WSL)                      │
│                                                             │
│   Channel Layer (QQ收发, WebSocket) ◄────────────────────┐      │
│   /tools/invoke HTTP API  ───────────────────────────┐   │      │
│   Plugin SDK: resolveAgentRoute 包装 → HTTP Forward  │   │      │
│   Gateway: 127.0.0.1:18789                           │   │      │
└──────────────┬──────────────────────────────────┼───┼──────┘
               │ POST /events/openclaw             │   │ 发消息回QQ
               ▼                                   │   │
┌──────────────────────────────────────────────────────────────┐
│              Workflow Engine (Node.js, WSL 独立服务)          │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  Event Gateway                       │    │
│  │  POST /events/openclaw                               │    │
│  │  POST /events/manual                                 │    │
│  │  POST /events/schedule                               │    │
│  │                                                      │    │
│  │  verify signature → normalize → dedupe → event_inbox │    │
│  └──────────────────────────┬──────────────────────────┘    │
│                             │ 异步消费                        │
│  ┌──────────────────────────▼──────────────────────────┐    │
│  │                  Engine Core                         │    │
│  │  状态机 (pending→running→done/failed/retrying)       │    │
│  │  Context 传递 (step间数据共享)                        │    │
│  │  Dispatcher (串行/并行/条件 三种调度模式)              │    │
│  │  Retry + DLQ (重试策略 + 死信队列)                    │    │
│  │  断点续跑 (启动时恢复 running 状态的 run)              │    │
│  └──────────┬───────────────────────────────────────────┘    │
│             │                                                │
│   ┌─────────┼────────────────────────────────┐              │
│   ▼         ▼                                ▼              │
│ ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│ │ Model Layer │  │  RAG Layer   │  │  OpenClaw Client  │   │
│ │             │  │              │  │                   │   │
│ │ 百炼 chat   │  │ embedder     │  │ /tools/invoke     │   │
│ │ 百炼 embed  │  │ retriever    │  │ skill-proxy step  │   │
│ │ OpenAI兼容  │  │ rerank(BM25) │  │ outbound sender   │   │
│ │ router      │  │ ingest(增量) │  │ session-mapper    │   │
│ └──────┬──────┘  └──────┬───────┘  └────────┬──────────┘   │
│        │                │                    │              │
│  ┌─────▼────────────────▼────────────────────▼────────┐    │
│  │                SQLite (统一持久层)                   │    │
│  │  event_inbox | conversations | workflow_runs        │    │
│  │  step_runs   | message_outbox | dlq                 │    │
│  │  knowledge_docs | knowledge_chunks | knowledge_vecs │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、项目目录结构

```
workflow-engine/
├── core/
│   ├── engine.js              # 主引擎：消费 event_inbox，创建并驱动 workflow run
│   ├── context.js             # 流程上下文，step 间数据传递与隔离
│   ├── state-machine.js       # 状态转换: pending→running→done/failed/retrying
│   ├── dispatcher.js          # 当前为串行调度入口（并行/条件由 step 实现）
│   └── retry.js               # 重试策略(指数退避) + 死信队列写入
│
├── steps/
│   ├── index.js               # Step 注册与工厂
│   ├── base.step.js           # Step interface: execute(ctx) → {ok, output, error}
│   ├── parallel.step.js       # 并行执行多个子step的容器
│   ├── conditional.step.js    # 条件分支 step
│   ├── transform.step.js      # 轻量数据变换 step
│   ├── noop.step.js           # 占位 step
│   ├── skill-proxy.step.js    # 通用 OpenClaw Skill 代理（复用全部 Skill 生态）
│   ├── rag-query.step.js      # 知识库检索 step
│   ├── hotspot.step.js        # 热点话题提炼 step（融合搜索/RAG结果）
│   ├── topic.step.js          # 主题生成
│   ├── write.step.js          # 内容生成
│   ├── polish.step.js         # 内容润色
│   └── publish.step.js        # 发布（写 outbox，由 worker 发送）
│
├── models/
│   ├── base.model.js          # interface: chat(messages,opts) / embedding(text)
│   ├── bailian.model.js       # 阿里云百炼（兼容 OpenAI 格式）
│   ├── openai-compat.model.js # 其他兼容 OpenAI 格式的模型（DeepSeek/Qwen等）
│   └── router.js              # 按任务类型路由: chat/embedding/reasoning 分别选模型
│
├── openclaw/
│   ├── client.js              # 调用 OpenClaw HTTP: /tools/invoke, 发消息
│   ├── adapter.js             # payload 标准化: 三种格式 → InternalEvent
│   ├── session-mapper.js      # OpenClaw session ↔ conversation ↔ workflow_run 映射
│   └── hooks/
│       └── my-qq-filter.js # 部署到 OpenClaw 的 Plugin SDK 插件，转发 QQ 消息到引擎
│
├── rag/
│   ├── embedder.js            # 百炼 text-embedding-v4，批量 embed
│   ├── store.js               # sqlite-vec 向量读写
│   ├── retriever.js           # 向量召回 + BM25 rerank
│   ├── chunker.js             # MD 文件按标题层级语义分块
│   └── ingest.js              # 增量导入 CLI: sha256 变更检测，只处理变化文件
│
├── persist/
│   ├── db.js                  # better-sqlite3 单例, WAL模式, busy_timeout
│   ├── schema.sql             # 全部建表 DDL
│   └── repos/
│       ├── event.repo.js      # event_inbox CRUD
│       ├── workflow.repo.js   # workflow_runs CRUD
│       ├── step.repo.js       # step_runs CRUD
│       ├── conversation.repo.js  # conversations CRUD
│       ├── outbox.repo.js     # message_outbox CRUD
│       ├── dlq.repo.js        # 死信队列 CRUD
│       └── knowledge.repo.js  # knowledge_docs / chunks / vectors CRUD
│
├── workflows/
│   ├── article.flow.js        # 文章生成流程
│   └── analysis.flow.js       # 热点分析报告流程
│
├── trigger/
│   ├── webhook.js             # Fastify HTTP server, 托管 /events/* 路由
│   ├── outbox-worker.js       # outbox 轮询发送
│   └── scheduler.js           # node-cron 定时触发
│
├── utils/
│   └── logger.js              # pino 日志封装
│
├── config/
│   └── index.js               # 统一环境变量读取（dotenv）
│
├── knowledge/                 # 默认语料目录（Markdown 文件放这里）
│
├── .env.example
├── package.json
└── index.js                   # 入口：启动 HTTP server + engine + outbox-worker + scheduler
```

---

## 四、核心 Interface 定义

### 4.1 Step Interface

```js
// steps/base.step.js
class BaseStep {
  get name() { throw new Error('name required') }
  get retryable() { return true }
  get timeout() { return 30_000 }  // ms
  async execute(context) {
    // 返回值结构固定
    // return { ok: true, output: any }
    // return { ok: false, error: string }
    throw new Error('execute() not implemented')
  }
}
```

### 4.2 Model Interface

```js
// models/base.model.js
class BaseModel {
  get name() { throw new Error('name required') }
  async chat(messages, options = {}) {
    // messages: [{role, content}]
    // return { content: string, usage: {prompt_tokens, completion_tokens} }
    throw new Error('chat() not implemented')
  }
  async embedding(text) {
    // return Float32Array (1024 维, 百炼 v4)
    throw new Error('embedding() not implemented')
  }
}
```

### 4.3 Skill Interface（通过 skill-proxy.step.js 统一封装）

```js
// 工作流定义中使用示例
{
  type: 'skill-proxy',
  skill: 'web-search',           // OpenClaw Skill 名称
  timeout: 15_000,
  input: (ctx) => ({             // 动态从 context 取参数
    query: ctx.get('topic')
  }),
  output: 'searchResults'        // 结果写入 context 的 key
}
```

### 4.4 InternalEvent（事件标准化结构）

```js
{
  eventId:       'evt_xxxxxx',    // 引擎内部唯一ID
  source:        'openclaw',      // 事件来源
  sourceEventId: 'qq_msg_123',    // 来源侧原始ID（用于幂等去重）
  triggerType:   'message',       // message / schedule / manual
  userId:        'u_001',
  channelId:     'group_001',
  text:          '帮我写一篇关于xx的文章',
  metadata: {
    rawPayload:  {},
    receivedAt:  1710000000
  }
}
```

### 4.5 Workflow 声明式定义格式

```js
// workflows/article.flow.js
module.exports = {
  id: 'article_flow',
  name: '公众号文章生成',
  trigger: {
    type: 'message',
    match: /写文章|写公众号|帮我写|生成文章/
  },
  steps: [
    { type: 'topic' },
    {
      type: 'rag-query',
      input: ctx => ({ query: ctx.get('topic') }),
      output: 'ragResults',
      topK: 5
    },
    {
      type: 'conditional',
      condition: (ctx) => Array.isArray(ctx.get('ragResults')) && ctx.get('ragResults').length === 0,
      ifTrue: {
        type: 'skill-proxy',
        skill: 'web-search',
        input: ctx => ({ query: ctx.get('topic') }),
        output: 'searchResults',
        timeout: 15000
      },
      ifFalse: { type: 'noop' }
    },
    { type: 'write' },
    { type: 'polish' },
    { type: 'publish' }
  ],
  onError: 'notify-and-dlq'
}
```

---

## 五、SQLite 数据库表结构

```sql
-- persist/schema.sql

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. 事件收件箱
-- ============================================================
CREATE TABLE IF NOT EXISTS event_inbox (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,           -- 'openclaw' / 'schedule' / 'manual'
  source_event_id TEXT,                    -- 来源侧原始ID，幂等去重用
  event_type      TEXT NOT NULL,           -- 'message' / 'schedule'
  payload_json    TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',  -- pending / processing / done / failed
  workflow_run_id TEXT,                    -- 关联的 run
  created_at      INTEGER NOT NULL,
  processed_at    INTEGER,
  UNIQUE(source, source_event_id)          -- 幂等唯一约束
);

-- ============================================================
-- 2. 会话（多轮对话上下文）
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  user_id       TEXT,
  last_run_id   TEXT,                      -- 上一次 workflow run
  context_json  TEXT,                      -- 必要的上下文快照（多轮追问用）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_channel ON conversations(source, channel_id);

-- ============================================================
-- 3. 工作流运行记录
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_runs (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT NOT NULL,           -- 对应 workflows/*.flow.js 的 id
  conversation_id TEXT,
  event_id        TEXT,                    -- 触发来源 event
  status          TEXT DEFAULT 'pending',  -- pending/running/done/failed/retrying
  context_json    TEXT,                    -- 当前 context 快照（断点续跑用）
  current_step    TEXT,                    -- 当前执行到的 step name
  error           TEXT,
  started_at      INTEGER,
  finished_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);

-- ============================================================
-- 4. Step 运行记录
-- ============================================================
CREATE TABLE IF NOT EXISTS step_runs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id),
  step_name       TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  status          TEXT DEFAULT 'pending',  -- pending/running/done/failed/skipped
  input_json      TEXT,
  output_json     TEXT,
  error           TEXT,
  retry_count     INTEGER DEFAULT 0,
  duration_ms     INTEGER,
  token_used      INTEGER,                 -- 本 step 消耗的 token 数
  started_at      INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_step_runs_run ON step_runs(run_id);

-- ============================================================
-- 5. 消息出站箱（Outbox Pattern）
-- ============================================================
CREATE TABLE IF NOT EXISTS message_outbox (
  id          TEXT PRIMARY KEY,
  run_id      TEXT,
  target      TEXT NOT NULL,               -- 目标: 'openclaw'
  channel_id  TEXT NOT NULL,              -- QQ 群/会话 ID
  content     TEXT NOT NULL,
  status      TEXT DEFAULT 'pending',     -- pending / sent / failed
  retry_count INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);

-- ============================================================
-- 6. 死信队列
-- ============================================================
CREATE TABLE IF NOT EXISTS dlq (
  id           TEXT PRIMARY KEY,
  run_id       TEXT,
  step_name    TEXT,
  error        TEXT,
  input_json   TEXT,
  retry_count  INTEGER,
  created_at   INTEGER NOT NULL,
  replayed_at  INTEGER
);

-- ============================================================
-- 7. 知识库 - 文档
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL UNIQUE,
  file_hash   TEXT NOT NULL,              -- sha256，增量判断
  title       TEXT,
  status      TEXT DEFAULT 'active',      -- active / deleted
  chunk_count INTEGER DEFAULT 0,
  indexed_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ============================================================
-- 8. 知识库 - 分块
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES knowledge_docs(id),
  chunk_index INTEGER NOT NULL,
  heading     TEXT,                       -- 所在 MD 标题（检索结果增强用）
  content     TEXT NOT NULL,
  token_count INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);

-- ============================================================
-- 9. 知识库 - 向量索引 (sqlite-vec)
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vectors USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding float[1024]                   -- 百炼 text-embedding-v4 维度
);
```

---

## 六、关键流程时序

### 6.1 QQ 消息触发工作流

```
QQBot 消息
  → OpenClaw 收到（WebSocket 接入，非 HTTP webhook）
  → my-qq-filter 插件（Plugin SDK，部署在 OpenClaw plugins/ 目录）
      监听官方 api.on('message_received')
      收到 event + ctx 后做去重与标准化（source/channelId/userId/text/ts/metadata）
  → POST /events/openclaw (Bearer OPENCLAW_WEBHOOK_SECRET)
  → trigger/webhook.js 验证 shared secret
  → adapter.js 标准化为 InternalEvent（兼容三种格式）
  → event_inbox 写库 (幂等: UNIQUE source+source_event_id)
  → 立即返回 202
  → index.js 的 pollEvents 循环 每秒消费 event_inbox
  → engine.js matchWorkflow (按 trigger.match 正则匹配)
  → mapToConversation 创建/复用 conversation
  → 创建 workflow_run
  → dispatcher.js 串行驱动各 step
  → 每个 step 结果写 step_runs
  → context 快照定期更新到 workflow_runs
  → publish.step.js 写 message_outbox
  → outbox-worker.js 轮询发送 → openclaw/client.js → POST /tools/invoke → QQ
```

**adapter.js 支持的三种入站格式：**

| 格式 | 特征字段 | 来源 |
|------|----------|------|
| QQ Bot 原始事件 | `{ t, d }` | hook 直传原始事件 |
| hook 转发格式 | `{ hookEvent, sessionKey, context }` | internal hook 封装后发送（备用） |
| 扁平通用格式 | `{ channelId, userId, text, ... }` | 插件转发 / 手动触发 / 其他系统 |

**插件转发 payload（格式三，扁平通用）：**
```json
{
  "source":    "qqbot-plugin",
  "channelId": "qqbot:c2c:<user_openid>",
  "userId":    "<user_openid>",
  "text":      "用户消息内容",
  "ts":        1776514520376,
  "metadata": {
    "peerId":         "<user_openid>",
    "peerKind":       "direct",
    "accountId":      "default",
    "messageId":      "<message_id>",
    "sessionKey":     "qqbot:c2c:<user_openid>",
    "conversationId": "qqbot:c2c:<user_openid>",
    "qqEventType":    "unknown",
    "pluginId":       "my-qq-filter",
    "pluginVersion":  "1.0.0"
  }
}
```

**当前联调状态（2026-04-20）：✅ QQ 消息接收端已完全联调成功**

- `my-qq-filter.js` 已成功部署并注册 `message_received` hook。
- 实测 `event` / `ctx` 字段完整（`content`、`messageId`、`senderId`、`conversationId` 可用）。
- `channelId` / `userId` 映射正确：
  - `channelId = qqbot:c2c:<user_openid>`
  - `userId/peerId = <user_openid>`
- 去重逻辑已启用（基于 `messageId` + TTL）。
- QQ 接收侧已完全打通。
- 发送侧（`message` tool action/args）在核心代码完成后进行联调验证，架构上已确保实现路径可行（`publish.step.js → message_outbox → outbox-worker → openclaw/client.js → /tools/invoke`）。


**channelId 格式（qqbot target）：**

| 场景 | 格式 |
|------|------|
| QQ 私聊 | `qqbot:c2c:<user_openid>` |
| QQ 群消息 | `qqbot:group:<group_openid>` |
| QQ 频道 | `qqbot:channel:<channel_id>` |

### 6.2 增量知识库更新

```
运行 node rag/ingest.js --dir ./knowledge
  → 扫描所有 .md 文件
  → 计算每个文件的 sha256
  → 对比 knowledge_docs 表中记录的 hash
  → 未变化的文件 → 跳过
  → 新增/变更的文件:
      → chunker.js 按 MD 标题语义分块 (400~600 token/chunk)
      → 删除旧的 chunks 和 vectors (如果是更新)
      → embedder.js 批量调百炼 embedding API (每批 20 个 chunk)
      → 写入 knowledge_chunks 和 knowledge_vectors
      → 更新 knowledge_docs 的 hash 和 indexed_at
  → 已删除的文件 → status='deleted'，清除对应数据
```

### 6.3 RAG 检索流程

```
rag-query.step.js 执行
  → 取 context 中的 query
  → embedder.js 生成 query 向量
  → sqlite-vec 向量相似度检索 Top 20
  → BM25 关键词重排 Top 5
  → 组装 chunks + 标题 作为 context 注入下一个 step
```

> **关于引入 Rerank 模型的评估（暂不实现）：**
> 当前 BM25 重排是纯关键词频率统计，无法理解语义。引入交叉编码器（cross-encoder）级别的 rerank 模型（如百炼 `gte-rerank`）可对 Top20 候选做逐对语义打分，Top5 准确率通常提升 **15%~30%**（在长尾问题和同义表达场景最显著）。
> 代价：每次检索需额外调用一次 rerank API（约 100~300ms 延迟 + 少量费用）。
> **当前决策**：先不引入，等 article.flow.js 端到端跑通后评估实际召回质量，如出现明显误召再加。

### 6.4 断点续跑（引擎重启后）

```
index.js 启动
  → 查询 status IN ('running', 'pending') 的 workflow_runs
  → 读取 context_json 快照恢复 context
  → 找到 last completed step
  → 从下一个 step 继续执行（不重跑已完成的 step）
```

---

## 七、OpenClaw Skill 复用方案

通过 `skill-proxy.step.js` 统一代理，任何 OpenClaw Skill 都可直接在 workflow 中使用：

```
Workflow 定义引用 skill-proxy
  → skill-proxy.step.js 执行
  → openclaw/client.js POST /tools/invoke
  → { tool: '<skill名>', action: '<action>', args: { ... }, sessionKey: 'main', dryRun: false }
  → 返回结果写入 context
  → 下游 step 消费结果
```

**可直接复用的 Skill 类别（无需自行实现）：**

| 类别 | Skill 示例 |
|------|-----------|
| 搜索 | web-search, news-search |
| 内容读取 | read-url, parse-pdf |
| 代码执行 | code-executor |
| 通知推送 | message（qqbot:c2c / qqbot:group / qqbot:channel）, email |
| 文件操作 | file-read, file-write |
| 用户自建 | 任意自建 Plugin |

**注意事项：**
- 单次 Skill 调用设置超时（默认 15s）
- 同一 run 内相同参数的 Skill 结果可缓存（TTL 5 分钟）
- 多个 Skill 并发调用使用 `parallel.step.js` 容器

---

## 八、模型路由策略

```js
// models/router.js 路由规则示例
const routingTable = {
  embedding: 'bailian',          // embedding 固定用百炼
  writing:   'bailian-plus',     // 长文生成用更强的模型
  analysis:  'bailian',          // 分析任务
  reasoning: 'qwen-max',         // 需要推理的任务
  fallback:  'bailian'
}
```

- 百炼 API 完全兼容 OpenAI 格式，使用 `openai` npm 包接入
- 新增其他模型只需实现 `base.model.js` interface
- 路由规则在 config 中可配置，不硬编码

---

## 九、稳定性保障措施

| 措施 | 实现方式 |
|------|----------|
| SQLite 高并发写 | WAL 模式 + busy_timeout=5000ms |
| 外部服务熔断 | `client.js` 内置简易熔断器，连续失败 N 次触发熔断，30s 后恢复探测 |
| 百炼 API 限流 | 全局并发队列，chat≤3并发，embedding≤5并发 |
| Step 超时 | 每个 step 独立超时控制（BaseStep.timeout） |
| 进程崩溃恢复 | 启动时扫描 running 状态 run，自动断点续跑（recoverRuns） |
| Webhook 鉴权 | Bearer shared-secret（`Authorization: Bearer <secret>` 或 `x-openclaw-webhook-secret`），`/events/manual` 同等鉴权 |
| WAL checkpoint | `trigger/scheduler.js` 每天凌晨 3 点自动执行 `PRAGMA wal_checkpoint(TRUNCATE)` |
| 去重保证 | event_inbox 的 UNIQUE(source, source_event_id) |
| 发送可靠性 | Outbox Pattern：先落库再发送，失败自动重试（MAX_SEND_RETRIES=3） |
| 死信队列 | 超过重试次数进入 DLQ，支持手动重放 |
| Prompt 注入防护 | 用户输入过滤特殊指令前缀，prompt 模板化而非拼接 |

---

## 十、可观测性

### 每个 step_run 记录
- 耗时（duration_ms）
- token 消耗（token_used）
- 重试次数（retry_count）
- 完整 input/output 快照

### 结构化日志（pino）
```json
{
  "level": "info",
  "event": "step.completed",
  "runId": "run_xxx",
  "stepName": "write",
  "duration_ms": 1240,
  "tokenUsed": 850
}
```

### 后期可扩展
- 简单 Web Dashboard（今日运行数/成功率/耗时/成本趋势）
- token 成本统计（按 workflow / 按用户维度）

---

## 十一、技术选型

| 模块 | 选型 | 理由 |
|------|------|------|
| HTTP 框架 | `fastify` | 比 express 快 3 倍，内置 schema 验证 |
| SQLite 驱动 | `better-sqlite3` | 同步 API，WAL 模式，WSL 性能优秀 |
| 向量搜索 | `sqlite-vec` | 与状态库统一，省去独立向量DB |
| Rerank | BM25（本地实现）| 无外部依赖，向量召回后关键词二次排序（⚠️ 当前 IDF 公式待修正） |
| 百炼 SDK | `openai` npm 包 | 百炼完全兼容 OpenAI 格式 |
| 熔断器 | `client.js` 内置实现 | 轻量，无额外依赖 |
| 定时任务 | `node-cron` | 轻量够用 |
| 日志 | `pino` | 结构化日志，性能最好 |
| 环境变量 | `dotenv` | 标准方案 |

---

## 十二、环境变量

```env
# .env.example

# 服务
PORT=3000
NODE_ENV=development

# 阿里云百炼
BAILIAN_API_KEY=sk-xxxx
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_CHAT_MODEL=qwen-plus
BAILIAN_EMBED_MODEL=text-embedding-v4

# OpenClaw
OPENCLAW_BASE_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-gateway-token
OPENCLAW_DEFAULT_SESSION_KEY=main
OPENCLAW_WEBHOOK_SECRET=your-webhook-shared-secret
OPENCLAW_MESSAGE_TOOL=message
OPENCLAW_MESSAGE_ACTION=send
OPENCLAW_MESSAGE_TARGET_ARG=target
OPENCLAW_MESSAGE_CONTENT_ARG=content
OPENCLAW_MESSAGE_TARGET_PREFIX=qqbot:group:
OPENCLAW_MESSAGE_CHANNEL=qqbot
OPENCLAW_ACCOUNT_ID=

# Scheduler
SCHEDULER_CHANNEL_ID=qqbot:c2c:<user_openid>
SCHEDULER_CRON=0 8 * * *
SCHEDULER_TEXT=定时内容生成任务

# SQLite
DB_PATH=./data/engine.db
KNOWLEDGE_DIR=./knowledge

# 并发控制
# pollEvents 每轮最多并发消费的 event 数
MAX_CONCURRENT_RUNS=5
MAX_CONCURRENT_LLM_CALLS=3
MAX_CONCURRENT_EMBED_CALLS=5

# 熔断器
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_RESET_MS=30000
```

---

## 十三、MVP 开发顺序

| 阶段 | 内容 | 状态 |
|------|------|------|
| 第 1 步 | `persist/schema.sql` + `persist/db.js` | ✅ 完成 |
| 第 2 步 | `core/state-machine.js` + `core/context.js` | ✅ 完成 |
| 第 3 步 | `core/engine.js` + `core/dispatcher.js` + `core/retry.js` | ✅ 完成 |
| 第 4 步 | `steps/` 全部基础 step | ✅ 完成 |
| 第 5 步 | `openclaw/adapter.js` + `trigger/webhook.js` | ✅ 完成 |
| 第 6 步 | `openclaw/client.js` + `steps/skill-proxy.step.js` | ✅ 完成 |
| 第 7 步 | `models/bailian.model.js` + `models/router.js` | ✅ 完成 |
| 第 8 步 | `rag/` 全部模块 + `steps/rag-query.step.js` | ✅ 完成 |
| 第 9 步 | `workflows/article.flow.js` + `index.js` | ✅ 完成 |
| 第 10 步 | 端到端启动联调 + Bug 修复 | 🔧 进行中 |

---

## 十四、OpenClaw 集成要点（已确认）

### /tools/invoke 请求格式（官方 4.14）
```json
POST http://127.0.0.1:18789/tools/invoke
Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
Content-Type: application/json
x-openclaw-message-channel: qqbot

{
  "tool": "<tool名>",
  "action": "<action名>",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

响应格式：
```json
{ "ok": true, "result": { ... } }
{ "ok": false, "error": { "type": "...", "message": "..." } }
```

### 发 QQ 消息
```json
{
  "tool": "message",
  "action": "send",
  "args": {
    "target": "qqbot:c2c:<user_openid>",
    "content": "消息内容"
  },
  "sessionKey": "main"
}
```

target 格式：
- 私聊：`qqbot:c2c:<user_openid>`
- 群消息：`qqbot:group:<group_openid>`
- 频道：`qqbot:channel:<channel_id>`

### 插件转发 payload（qqbot-forwarder 插件 → workflow engine）

插件使用 Plugin SDK `api.runtime.channel.routing.resolveAgentRoute` 包装，在 handler 层拿到消息内容后转发：

```json
POST /events/openclaw
Authorization: Bearer <OPENCLAW_WEBHOOK_SECRET>
Content-Type: application/json

{
  "source":    "qqbot-plugin",
  "channelId": "qqbot:c2c:<user_openid>",
  "userId":    "<user_openid>",
  "text":      "用户消息内容",
  "ts":        1776514520376,
  "metadata": {
    "peerId":    "<user_openid>",
    "peerKind":  "direct",
    "accountId": "default",
    "messageId": "<message_id>",
    "sessionKey": "agent:main:qqbot:direct:<openid>"
  }
}
```

adapter.js 用格式三（扁平通用）处理此格式，`metadata.messageId` 和 `metadata.sessionKey` 均已支持。

> **联调已完成**：`my-qq-filter.js` 已实测，SDK `event.content` / `event.metadata.senderId` / `ctx.conversationId` 字段均可正确取到，插件内置多路兜底，字段映射稳定。

### OpenClaw 鉴权
- Gateway token（调 /tools/invoke 用）：`OPENCLAW_GATEWAY_TOKEN`
- Webhook shared secret（hook 转发时用）：`OPENCLAW_WEBHOOK_SECRET`
- 两个 secret 独立配置，互不干扰

### QQ Bot session key 格式
```
agent:<mainKey>:qqbot:<chatType>:<openId>
```
- chatType: `direct`（私聊）/ `group`（群）/ `channel`（频道）

---

## 十五、已完成与未完成

### ✅ 已完成
- `persist/schema.sql` — 全量 DDL（9 张表）
- `persist/db.js` — better-sqlite3 单例，WAL 模式（v1.2 新增 `isVectorAvailable()` 导出，sqlite-vec 加载失败时返回 false，供 retriever 降级判断）
- `persist/repos/` — 所有 repo CRUD（v1.1 `conversation.repo.js` 增加安全合并更新与历史追加能力；v1.2 `outbox.repo.js` 新增 `resetStaleSendingMessages`；v1.2 `event.repo.js` `markFailed` 补写关联 run 的 error 字段）
- `core/state-machine.js` — 状态转换
- `core/context.js` — step 间数据传递（v1.2 新增 `snapshot()` 方法，供 parallel 子步骤隔离写入；新增 `delete(key)`）
- `core/engine.js` — 消费 event_inbox，驱动 workflow（v1.1 修复断点续跑位点；v1.2 新增 `_handleOnError`、断点恢复重建 conversation、runStep 前置 requires 校验、子步骤 prevIndex 恢复；v1.3 所有状态转换前从 DB 读取真实状态再校验）
- `core/dispatcher.js` — 串行调度入口（并行/条件由对应 step 实现）
- `core/retry.js` — 指数退避 + DLQ 写入（v1.2 对 `notRetryable/isInputError` 错误直接跳出不重试）
- `steps/base.step.js` — Step interface（v1.2 新增 `requires`/`provides` 声明）
- `steps/index.js` — Step 注册中心/工厂
- `steps/parallel.step.js` — 并行容器（v1.2 子步骤使用 context 快照，stepIndex 改为负数命名空间）
- `steps/conditional.step.js` — 条件分支 step（v1.2 子步骤 stepIndex 改为负数，避免与顶层污染）
- `steps/transform.step.js` — 轻量数据变换 step
- `steps/noop.step.js` — 占位 step
- `steps/skill-proxy.step.js` — OpenClaw Skill 代理（已对齐 /tools/invoke 官方格式）
- `steps/rag-query.step.js` — RAG 检索 step（v1.2 补 `requires/provides` 声明）
- `steps/topic.step.js` — 主题生成（v1.1 注入最近多轮历史；v1.2 补 `requires/provides` 声明及输入守卫）
- `steps/hotspot.step.js` — 热点话题提炼（融合 searchResults/ragResults，v1.2 补 `provides` 声明）
- `steps/write.step.js` — 正文生成（v1.2 补 `requires/provides` 声明及输入守卫）
- `steps/polish.step.js` — 正文润色（v1.2 补 `requires/provides` 声明）
- `steps/publish.step.js` — 写 outbox（v1.1 写入后 emit `new_message`；v1.2 补 `requires` 声明）
- `workflows/article.flow.js` — 文章流程已落地（topic → rag-query → conditional(web-search/noop) → write → polish → publish）
- `workflows/analysis.flow.js` — 热点分析报告流程（topic → rag-query → conditional(web-search/noop) → hotspot → write → polish → publish）
- `openclaw/client.js` — 对齐官方格式（Bearer token、args、sessionKey、qqbot target 动态构建）
- `openclaw/adapter.js` — 三种入站格式标准化（QQ Bot 原始事件 / hook 转发 / 扁平）
- `openclaw/session-mapper.js` — session ↔ conversation 映射（v1.1 新增 `getConversationHistory` 工具函数）
- `openclaw/hooks/my-qq-filter.js` — ✅ QQ 消息接收转发联调成功
- `trigger/webhook.js` — shared-secret 鉴权，202 响应（v1.3 `/events/manual` 也强制鉴权）
- `trigger/outbox-worker.js` — outbox 发送（v1.1 升级为 EventEmitter 事件驱动 + 5s 轮询兜底；v1.2 启动时调用 `resetStaleSendingMessages` 自动恢复卡死消息）
- `trigger/scheduler.js` — node-cron 定时触发（v1.1.1 改为配置化：`SCHEDULER_CHANNEL_ID` / `SCHEDULER_CRON` / `SCHEDULER_TEXT`；v1.3 新增每日凌晨 3 点 WAL checkpoint 任务）
- `index.js` — 入口启动（HTTP + event poll + outbox worker + scheduler；v1.3 `pollEvents` 改为按 `MAX_CONCURRENT_RUNS` 并发消费）
- `config/index.js` — 完整环境变量读取
- `models/bailian.model.js` — 百炼直连（v1.2 `chat()` 新增 `chatSemaphore` 信号量，真正落地 `MAX_CONCURRENT_LLM_CALLS` 并发控制）
- `models/router.js` — 模型路由
- `rag/chunker.js` — MD 标题语义分块
- `rag/embedder.js` — 百炼 embedding
- `rag/store.js` — sqlite-vec 向量读写（v1.1 新增语料总量 N 与关键词 df 统计接口）
- `rag/ingest.js` — 增量导入
- `rag/retriever.js` — 向量召回 + BM25 rerank（v1.1 修正 IDF；v1.2 启动时检查 `isVectorAvailable()`，不可用直接降级 textSearch）
- `utils/logger.js` — pino 日志封装
- `DEPLOY.md` — 生产部署指南（v1.2 更新所有修复状态；v1.3 更新安全和运维章节）

### ❌ 未完成 / 待修复

#### ~~必须完成（高优先级）~~ — 全部已完成（2026-04-20 v1.3）

- [x] **`trigger/outbox-worker.js` 改造** — v1.1 升级为 EventEmitter 事件驱动；v1.2 启动恢复 stale sending
- [x] **多轮对话上下文完善** — `engine.js` + `session-mapper.js` + `conversation.repo.js`（v1.1）
- [x] **`core/engine.js` 断点续跑修正**（v1.1 位点修正；v1.2 恢复 conversation）
- [x] **`rag/retriever.js` BM25 公式修正**（v1.1）
- [x] **P0-1 outbox sending 卡死**（v1.2：`resetStaleSendingMessages` 启动时自动恢复）
- [x] **P0-2 并发限流未实现**（v1.2：`chatSemaphore` 信号量落地；v1.3：`pollEvents` 改为 `Promise.all` 并发，`MAX_CONCURRENT_RUNS` 真正生效）
- [x] **P0-3 sqlite-vec 不可用崩溃**（v1.2：`isVectorAvailable()` + 降级 textSearch）
- [x] **P1-1 子步骤 stepIndex 污染**（v1.2：负数命名空间隔离）
- [x] **P1-2 onError 未生效**（v1.2：engine `_handleOnError()` 实现）
- [x] **P1-3 markFailed 不落库 error**（v1.2：写入关联 run.error）
- [x] **P1-4 断点恢复 conversation 丢失**（v1.2：recoverRuns 重建 conversation）
- [x] **step 约束机制优化**（v1.2：base.step.js `requires/provides`；engine 前置校验；retry 快速失败）
- [x] **安全：`/events/manual` 无鉴权**（v1.3：复用 `verifyWebhookAuth`）
- [x] **状态机校验不读 DB**（v1.3：`runWorkflow` / `recoverRuns` 所有转换前先 `getRunById` 读取真实状态）
- [x] **WAL 无定期 checkpoint**（v1.3：`scheduler.js` 新增每日凌晨 3 点自动 checkpoint）
- [x] **`cockatiel` 未使用依赖**（v1.3：从 `package.json` 移除）

#### 功能补齐（按需）
- [x] `steps/hotspot.step.js` — 热点话题发现 step
- [x] `workflows/analysis.flow.js` — 热点分析报告流程

#### 发送侧联调（核心代码稳定后进行）
- [x] 用 curl 验证 `message` tool 的真实 action 名（`client.js` 已全部环境变量化）
- [x] 验证 `args` 字段名（均通过 `.env` 配置，默认值即为 `target` / `content`）
- [ ] `.env` 填写真实的 `OPENCLAW_GATEWAY_TOKEN` 和 `OPENCLAW_WEBHOOK_SECRET`

#### 待确认
- [x] 百炼 text-embedding-v4 权限是否开通 → 已开通
- [x] 多 QQ 群对应不同 workflow 的需求 → 暂时不需要

---

## 十六、待确认事项（原十四章迁移）

- [x] ~~OpenClaw Webhook 的具体 payload 格式~~ → 已确认，走 my-qq-filter 插件 HTTP 转发
- [x] ~~OpenClaw `/tools/invoke` 的鉴权方式~~ → Bearer token，字段 `tool/action/args/sessionKey`
- [x] ~~`index.js` 入口是否完成~~ → 已完成，含 pollEvents / recoverRuns / HTTP server / scheduler
- [x] ~~百炼 API Key 是否已开通 `text-embedding-v4` 权限~~ → 已开通
- [x] ~~语料 MD 文件的大概数量和平均文件大小~~ → 七十多 MB，已分割为七百多个 100 KB 文件
- [x] ~~是否需要支持多个 QQ 群/频道对应不同 workflow~~ → 暂时不需要
- [x] `scheduler.js` 定时触发时目标 channelId 如何配置 → 已改为环境变量 `SCHEDULER_CHANNEL_ID`，`.env` 中填写目标 channelId（如 `qqbot:c2c:<openid>`）即可；同步新增 `SCHEDULER_CRON`、`SCHEDULER_TEXT`

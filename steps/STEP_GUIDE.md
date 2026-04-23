# Step 开发指南：约束规则与新增步骤说明

> 适用版本：v1.3+
> 文档路径：`steps/STEP_GUIDE.md`

---

## 目录

1. [Step 是什么](#1-step-是什么)
2. [BaseStep 接口](#2-basestep-接口)
3. [Context 约束机制（requires / provides）](#3-context-约束机制)
4. [执行流程与生命周期](#4-执行流程与生命周期)
5. [输出写回 Context 的规则](#5-输出写回-context-的规则)
6. [重试与超时规则](#6-重试与超时规则)
7. [子 Step 的 Index 命名空间](#7-子-step-的-index-命名空间)
8. [注册新 Step](#8-注册新-step)
9. [现有 Step 速查表](#9-现有-step-速查表)
10. [Step 能力目录（AI 编排指南）](#10-step-能力目录ai-编排指南)
11. [Context 数据流示例](#11-context-数据流示例)
12. [新增 Step 完整示例](#12-新增-step-完整示例)
13. [Workflow 中使用新 Step](#13-workflow-中使用新-step)
14. [Workflow 级 config 约定](#14-workflow-级-config-约定)
15. [常见错误与排查](#15-常见错误与排查)
16. [AI 编排提示语模板（可直接复制）](#16-ai-编排提示语模板可直接复制)

---

## 1. Step 是什么

Step 是 WorkflowEngine 的最小执行单元。每个 Step：

- 从 `WorkflowContext` 读取所需数据
- 执行业务逻辑（调用 LLM、查询数据库、调用外部服务等）
- 将结果写回 `WorkflowContext`，供后续 Step 使用

所有 Step 必须继承 `BaseStep`（`steps/base.step.js`）。

---

## 2. BaseStep 接口

```js
class BaseStep {
  // 【必须 override】Step 的唯一标识，与注册 key 一致
  get name() { throw new Error('must implement') }

  // Step 功能描述（供 AI 编排与 getStepCatalog() 消费）
  get description() { return '未声明' }

  // Step 分类：content-creation / data-fetch / retrieval / integration / flow-control / output
  get category() { return 'uncategorized' }

  // 默认 true；设为 false 则失败后不重试，直接进 DLQ
  get retryable() { return true }

  // 单次执行超时，毫秒；可在 stepDef 中用 timeout 字段覆盖
  get timeout() { return 30_000 }

  // 声明执行前 context 必须存在的 key；缺失 → 不重试，直接 DLQ
  get requires() { return [] }

  // 声明执行后写入 context 的 key（文档用途，不做强制校验）
  get provides() { return [] }

  // 【必须 override】执行入口
  async execute(context, stepDef) {
    // 返回：{ ok: true, output: any, usage?: { total_tokens: number } }
    throw new Error('must implement')
  }
}
```

---

## 3. Context 约束机制

### 3.1 requires：执行前校验

Engine 在调用 `execute()` 之前，会合并三处来源的 `requires` 声明并逐一校验：

| 来源 | 写法 | 优先级 |
|---|---|---|
| Step 类 `get requires()` | `return ['topic']` | 基础约束，每次都检查 |
| workflow 中 `stepDef.requires` | `requires: ['topic', 'ragResults']` | 追加约束（并集） |
| workflow 中 `stepDef.dependsOn` | `dependsOn: ['someKey']` | 同上，别名 |

**关键规则：**

- 任何一个 key 在 context 中不存在（`context.has(key) === false`），立刻抛出 `isInputError: true` 的错误
- 该错误**不会重试**，直接进死信队列（DLQ）
- 错误信息格式：`Step [stepName] (index=N, workflow=ID) missing required context key(s): key1, key2`

### 3.2 provides：执行后声明

`provides` 仅用于文档和代码自解释，引擎不做强制校验。

但是：**必须保证你在 `execute()` 里真的写入了这些 key**，否则下游 Step 的 `requires` 校验会失败。

### 3.3 Context 初始内置 key

Engine 启动时会将以下 key 注入 context，所有 Step 均可直接使用：

| key | 类型 | 说明 |
|---|---|---|
| `input` | `string` | 用户原始消息文本 |
| `event` | `object` | 完整的事件对象 |
| `channelId` | `string` | 目标频道/群 ID |
| `userId` | `string` | 发送者 ID |
| `conversationHistory` | `array` | 多轮对话历史（最近 10 条） |
| `_runId` | `number` | 当前 workflow run 的数据库 ID |
| `_config` | `object` | 当前 workflow 的配置对象（来自 `workflow.config`，未配置时为 `{}`） |
| `conversation` | `object` | 会话记录（来自 DB） |

`_` 前缀的 key 为引擎内部使用，Step 可读取但不应修改。

---

## 4. 执行流程与生命周期

```
Engine.runStep()
  │
  ├─ buildStep(stepDef, deps)         // 从注册表实例化 step
  │
  ├─ collectRequiredKeys(step, stepDef)
  ├─ assertRequiredContextKeys()      // ← 缺 key 直接报错，不重试
  │
  ├─ createStepRun() → DB 记录开始
  │
  ├─ withRetry(fn, maxRetries)        // retryable=false → maxRetries=0
  │    └─ executeWithTimeout(step, context, stepDef)
  │         └─ Promise.race([step.execute(), timeout])
  │
  ├─ 写回 context（见第 5 节）
  ├─ updateStepRun() → DB 记录结束
  └─ 恢复父步骤的 _currentStepIndex
```

**Step 内部不需要处理重试逻辑**，只需要在出错时 `throw Error`，引擎统一处理。

---

## 5. 输出写回 Context 的规则

`execute()` 返回值结构：`{ ok: true, output: any, usage?: {...} }`

引擎按以下规则将 `output` 写回 context：

| 条件 | 行为 |
|---|---|
| `stepDef.output = 'someKey'` | `context.set('someKey', output)` |
| 未配置 `stepDef.output`，且 `output` 是普通对象（非数组） | `context.merge(output)`，将 output 的所有 key 展开合并 |
| 未配置 `stepDef.output`，且 `output` 是数组或原始值 | **不写入 context**（会丢失！需要显式配置 `output`） |

**最佳实践：**

- Step 返回对象（如 `{ article: '...' }`）→ 自动 merge，推荐用于固定输出 key 的 Step
- Step 返回数组或任意结构 → 必须在 workflow 中配置 `output: 'targetKey'`

---

## 6. 重试与超时规则

### 重试

| 属性 | 默认 | 说明 |
|---|---|---|
| `step.retryable` | `true` | 返回 `false` → `maxRetries=0` |
| `stepDef.maxRetries` | `2` | 可在 workflow 中覆盖 |
| `err.isInputError = true` | — | 无论 retryable 如何，直接跳过重试 |
| `err.notRetryable = true` | — | 同上 |

重试间隔为指数退避（见 `core/retry.js`）。

**控制流 Step（parallel / conditional / transform / noop）一律设置 `retryable = false`**，避免重试带来的副作用。

### 超时

优先级：`stepDef.timeout` > `step.timeout` > 默认 30000ms

超时后抛出 `Error: Step timeout after Nms`，触发正常重试逻辑。

---

## 7. 子 Step 的 Index 命名空间

顶层 Step 的 `stepIndex` = 在 `workflow.steps` 数组中的下标（0-based 正整数）。

容器型 Step（parallel / conditional）内部的子 Step 使用**负数 index**，确保：

1. `recoverRuns()` 恢复时过滤 `step_index >= 0 && step_index < workflow.steps.length`，子 Step 不会被误计入恢复点
2. 不同容器的子 Step index 互不重叠

| 容器类型 | 子 Step index 公式 |
|---|---|
| `parallel`（父 index = P，子序号 = i） | `-(P * 1000 + i + 1)` |
| `conditional`（父 index = P） | `-(P + 1)` |

**自定义容器型 Step 必须遵循同样规则。**

---

## 8. 注册新 Step

### 方式 A：内置注册（推荐，静态注册）

1. 在 `steps/` 目录创建 `my-step.step.js`
2. 在 `steps/index.js` 中 require 并加入 `STEP_REGISTRY`：

```js
const MyStep = require('./my-step.step')

const STEP_REGISTRY = {
  // ...已有 step...
  'my-step': (def, deps) => new MyStep(),
}
```

### 方式 B：动态注册（运行时扩展）

```js
const { registerStep } = require('./steps')

registerStep('my-step', (def, deps) => new MyStep(deps))
```

注意：`registerStep` 如果重复注册同一 type 会抛出错误。

### deps 参数说明

Builder 函数的第二个参数 `deps` 包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `engine` | `WorkflowEngine` | 供子 Step 递归调用 `runStep()` |
| `workflow` | `object` | 当前 workflow 定义 |
| `conversation` | `object` | 当前会话记录 |

**只有需要递归执行子 Step 的容器型 Step 才需要 deps**（如 parallel、conditional）。普通 Step 可忽略。

---

## 9. 现有 Step 速查表

| type | category | requires（类声明） | provides | retryable | timeout | 说明 |
|---|---|---|---|---|---|---|
| `topic` | `content-creation` | `input` | `topic` | true | 20s | 从用户输入提炼写作主题（LLM） |
| `rag-query` | `retrieval` | `topic` | `ragResults` | true | 20s | 知识库向量检索（`stepDef.topK` > `_config.ragQuery.topK` > `5`） |
| `skill-proxy` | `integration` | —（由 stepDef.requires 配置） | — | true | 15s | 代理任意 OpenClaw Skill |
| `hotspot` | `content-creation` | — | `hotspot`, `hotspotSuggestions` | true | 30s | 热点话题提炼（LLM） |
| `write` | `content-creation` | `selectedTopic`, `research` | `article`, `articleData`, `articleJson` | true | 60s | 根据研究结果生成结构化文章（LLM） |
| `polish` | `content-creation` | `article` | `article`（覆盖） | true | 60s | 润色文章（LLM） |
| `publish` | `output` | `article`, `channelId`, `_runId` | — | true | 10s | 写入消息 outbox 并触发发送 |
| `conditional` | `flow-control` | — | — | **false** | 30s | 条件分支 |
| `parallel` | `flow-control` | — | — | **false** | 30s | 并行容器 |
| `transform` | `flow-control` | — | — | **false** | 30s | 纯函数数据变换 |
| `noop` | `flow-control` | — | — | **false** | 30s | 占位，不做任何事 |
| `fetch-hotspots` | `data-fetch` | — | `hotspots` | true | 30s | 抓取微博/头条/百度热点（真实API） |
| `generate-topics` | `content-creation` | `input`, `hotspots` | `topics`, `styleBrief`, `topicCandidates` | true | 40s | 生成多个候选话题（LLM） |
| `select-topic` | `content-creation` | `topics`, `input` | `selectedTopic`, `topic` | true | 30s | 从候选话题中选择最合适的 |
| `research` | `content-creation` | `selectedTopic` | `research` | true | 40s | 对话题进行研究分析（LLM） |
| `image-generate` | `content-creation` | `selectedTopic` | `coverPrompt`, `inlineImages` | true | 60s | 根据话题生成图片提示词 |
| `render-article` | `content-creation` | `articleData` | `finalMarkdown`, `finalHtml`, `images` | true | 30s | 将文章数据渲染为 HTML/Markdown |

---

## 10. Step 能力目录（AI 编排指南）

> 每个 Step 的 `description` 和 `category` 由源文件的 getter 定义，单一真相。
> 运行时可通过 `getStepCatalog()` 获取全量结构化数据，不需要解析本文档：
>
> ```js
> const { getStepCatalog } = require('./steps')
> const catalog = getStepCatalog() // 返回 { type, description, category, requires, provides, retryable, timeout }[]
> ```

### 分类说明

| category | 含义 |
|---|---|
| `content-creation` | LLM 驱动的内容生产与加工 |
| `data-fetch` | 外部数据抓取（API / 爬虫） |
| `retrieval` | 知识库或索引检索 |
| `integration` | 代理调用外部生态能力 |
| `flow-control` | 流程结构控制（分支 / 并行 / 变换） |
| `output` | 消息出站与发布 |

### 各 Step 一句话功能

| type | category | description |
|---|---|---|
| `fetch-hotspots` | data-fetch | 实时抓取微博/头条/百度热搜，失败自动降级为样本数据 |
| `generate-topics` | content-creation | 基于热点和用户需求，用 LLM 生成多个候选话题（含标题、简介、角度、评分） |
| `select-topic` | content-creation | 从候选话题中选择一个（支持用户显式选择、模型选择和评分回退） |
| `topic` | content-creation | 从用户输入中提炼清晰写作主题，作为后续检索与写作的上游输入（LLM） |
| `research` | content-creation | 围绕已选话题做写作前研究，输出角度、事实点、大纲、风险提示等（LLM） |
| `write` | content-creation | 根据选题与研究结果生成完整结构化文章（标题、摘要、分节、配图提示词等） |
| `image-generate` | content-creation | 根据选定话题自动匹配场景，生成封面图和文章内插图提示词 |
| `render-article` | content-creation | 将结构化文章数据渲染为发布用 HTML 与 Markdown，并提取图片位信息 |
| `hotspot` | content-creation | 从搜索结果或知识库中提炼热点话题与传播角度（LLM） |
| `polish` | content-creation | 对已有文章进行润色：保持原意，提升可读性与段落结构（LLM） |
| `rag-query` | retrieval | 对本地知识库进行向量检索，返回与 topic 相关的文档片段 |
| `skill-proxy` | integration | 代理调用 OpenClaw Skill 生态能力，避免为每个外部能力单独实现 step |
| `publish` | output | 将文章写入 outbox 发布队列并触发即时发送 |
| `conditional` | flow-control | 条件分支：根据 context 动态选择执行 ifTrue 或 ifFalse 子步骤 |
| `parallel` | flow-control | 并行执行多个子步骤，等待全部完成后汇总结果 |
| `transform` | flow-control | 执行轻量数据转换函数 stepDef.run(context) |
| `noop` | flow-control | 空操作占位，直接返回，不修改 context |

---

## 11. Context 数据流示例

```
input
  └─[topic]──► topic
                 ├─[topic]──► rag-query ──► ragResults
                 │              └──[ragResults empty?]──► skill-proxy ──► searchResults
                 │
                 └─[topic + ragResults? + searchResults?]──► write ──► article
                                                               └─[article]──► polish ──► article
                                                                                └─[article + channelId]──► publish
```

---

## 12. 新增 Step 完整示例

以下以"摘要 Step"为例，说明完整的新增过程。

### 12.1 创建 Step 文件：`steps/summarize.step.js`

```js
'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

class SummarizeStep extends BaseStep {
  get name() { return 'summarize' }
  get description() { return '将文章压缩为简洁摘要（LLM）' }
  get category() { return 'content-creation' }
  get timeout() { return 30_000 }
  get requires() { return ['article'] }   // 执行前必须有 article
  get provides() { return ['summary'] }   // 执行后写入 summary

  async execute(context, stepDef) {
    const article = context.get('article')
    const maxLen = stepDef.maxLen || 200   // 支持 stepDef 自定义参数

    const model = modelRouter.route('analysis')
    const { content, usage } = await model.chat([
      { role: 'system', content: '你是一位摘要助手，请用简洁的语言总结文章。' },
      { role: 'user', content: `请在 ${maxLen} 字以内总结以下文章：\n\n${article}` }
    ])

    // 返回对象 → 引擎自动 merge 到 context
    return { ok: true, output: { summary: content.trim() }, usage }
  }
}

module.exports = SummarizeStep
```

### 12.2 注册到 `steps/index.js`

```js
const SummarizeStep = require('./summarize.step')

const STEP_REGISTRY = {
  // ...已有 step...
  'summarize': (def, deps) => new SummarizeStep(),
}
```

### 12.3 在 workflow 中使用

```js
{
  type: 'summarize',
  maxLen: 150   // 传给 stepDef，在 execute(context, stepDef) 中读取
}
```

---

## 13. Workflow 中使用新 Step

### stepDef 完整字段说明

```js
{
  // 必填：对应 STEP_REGISTRY 中的 key
  type: 'my-step',

  // 可选：函数形式，从 context 提取参数传给 step（step 内通过 stepDef.input(context) 调用）
  // 若不设置，step 可直接从 context 读取所需数据
  input: ctx => ({ query: ctx.get('topic') }),

  // 可选：将 execute() 返回的 output 写入 context 的指定 key
  // 适合 output 是数组或需要明确 key 名的场景
  output: 'myResults',

  // 可选：追加 context 前置依赖检查（与 step.requires 取并集）
  requires: ['topic'],           // 或别名：dependsOn: ['topic']

  // 可选：覆盖 step.retryable，最大重试次数
  maxRetries: 1,

  // 可选：覆盖 step.timeout（ms）
  timeout: 10_000,

  // 以下为特定 step 的专属参数（step 内通过 stepDef 访问）
  topK: 5,          // rag-query 用
  skill: 'web-search',  // skill-proxy 用
  dryRun: false,    // skill-proxy 用
}
```

---

## 14. Workflow 级 config 约定

### 14.1 机制说明

Workflow 定义文件可在顶层添加 `config` 字段（纯 JSON 对象）。Engine 启动时将其注入 context，key 为 `_config`，所有 step 均可直接读取：

```js
// workflows/my.flow.js
module.exports = {
  id: 'my_flow',
  config: {
    ragQuery: {
      topK: 8   // 消费方：steps/rag-query.step.js
    }
    // 其他自定义配置...
  },
  trigger: { ... },
  steps: [ ... ]
}
```

```js
// step 内读取
const topK = stepDef.topK || context.get('_config')?.ragQuery?.topK || 5
```

**优先级**：`stepDef` 内联参数 > `_config` 字段 > step 内硬编码默认值

`_config` 遵循 `_` 前缀约定：step 可读取，不应修改。

### 14.2 双向约定规则

使用 `_config` 字段需在**两处**同时声明，形成可追溯的契约：

#### 1. Workflow 定义方（config 的每个 key 需注释消费方）

```js
config: {
  ragQuery: {
    topK: 5    // 消费方：steps/rag-query.step.js
  },
  write: {
    style: '科技感'   // 消费方：steps/write.step.js
  }
}
```

#### 2. Step 消费方（文件头 `@workflow-config` 块声明所有消费的 config 路径）

```js
/**
 * write step — 文章生成
 *
 * @workflow-config
 * - _config.write.style: 文章风格提示词（string，可选，默认由 LLM 自主发挥）
 */
class WriteStep extends BaseStep { ... }
```

如果一个 step **不消费任何 `_config` 字段**，则不需要添加 `@workflow-config` 块。

### 14.3 现有 config 字段速查表

| `_config` 路径 | 类型 | 默认值 | 消费 Step | 说明 |
|---|---|---|---|---|
| `_config.ragQuery.topK` | `number` | `5` | `rag-query` | 向量检索返回数量 |
| `_config.hotspots.enabledSources` | `array` | `['weibo','toutiao','baidu']` | `fetch-hotspots` | 启用的热点来源 |
| `_config.hotspots.limitPerSource` | `number` | `10` | `fetch-hotspots` | 每个来源取多少条 |
| `_config.hotspots.demo` | `boolean` | `false` | `fetch-hotspots` | 是否使用模拟数据 |
| `_config.account.authorName` | `string` | — | `render-article` | 作者署名 |
| `_config.account.authorWechat` | `string` | — | `render-article` | 作者微信号 |
| `_config.account.authorAvatar` | `string` | — | `render-article` | 作者头像URL |
| `_config.account.authorCardTemplate` | `string` | — | `render-article` | 作者卡片HTML模板 |

---

## 15. 常见错误与排查

### 错误 1：`Unknown step type: "xxx"`

**原因：** 使用了未注册的 step type。
**解决：** 检查 `steps/index.js` 的 `STEP_REGISTRY` 是否包含该 type。

---

### 错误 2：`Step [xxx] missing required context key(s): yyy`

**原因：** 前置 step 未写入 context，或 step 执行顺序有误。
**解决：**
- 确认 `provides` 包含该 key 的上游 step 在当前 step 之前
- 确认上游 step 确实执行成功（查 step_runs 表）
- 检查上游 step 返回的 output 字段名是否正确

---

### 错误 3：output 写入 context 后下游读不到

**原因：** execute() 返回的是数组，但未在 stepDef 配置 `output` key。
**解决：** 在 workflow 的 stepDef 加上 `output: 'targetKey'`。

---

### 错误 4：子 Step 被 `recoverRuns()` 误当顶层 step

**原因：** 自定义容器型 step 使用了正数 stepIndex。
**解决：** 子 step 的 index 必须是负数（参见第 7 节公式）。

---

### 错误 5：`Step type "xxx" is already registered`

**原因：** 重复调用 `registerStep()` 注册同一 type。
**解决：** 只注册一次，或检查模块是否被多次加载。

---

## 16. AI 编排规则与 Step 完整清单

> **本节设计目标**：AI 读完本文件后可直接生成可执行 workflow，用户无需额外提供 prompt 或 catalog。

### 16.1 编排硬约束（AI 必须遵守）

1. **优先使用 §16.2 catalog 中已存在的 `type`**。若当前 catalog 没有合适 step，必须先按本指南约束新增 step，并在同步 catalog 后再在 workflow 中引用新 type。
2. **每个 step 的 `requires`，必须在”初始 context”或”前序步骤 provides / stepDef.output 写入的 key”中已满足**。
   缺失会触发 `isInputError`，直接进 DLQ，不重试。
3. **step 输出为数组或原始值时，必须在 stepDef 显式配置 `output: 'key'`**。
   对象输出会自动 merge 到 context，不需要 output 字段（见 §5）。
4. **flow-control 类（conditional / parallel / transform / noop）不得承担内容生产职责**，只做流程结构控制。
5. **禁止伪造 step**：
   - 可改代码时：实现新 step（含实现/注册/声明 requires-provides/retryable/timeout）并同步到 §16.2；
   - 不可改代码时：返回”不可编排 + 缺失能力说明”。
6. 参数优先级：`stepDef` 内联参数 > `workflow.config`（`_config`）> step 内硬编码默认值。
7. **初始 context 保证可用的内置 key**（无需任何上游 step 即可使用）：

   | key | 类型 | 说明 |
   |---|---|---|
   | `input` | string | 用户原始消息文本 |
   | `channelId` | string | 目标频道/群 ID |
   | `userId` | string | 发送者 ID |
   | `conversationHistory` | array | 多轮对话历史（最近 10 条） |
   | `_runId` | number | 当前 workflow run 的 DB ID |
   | `_config` | object | workflow.config 注入的配置 |
   | `event` | object | 完整事件对象 |
   | `conversation` | object | 会话记录（来自 DB） |

### 16.2 Step Catalog（当前全量，与代码同步）

> 新增 step 后执行 `node scripts/update-step-guide.js` 更新此 JSON。
> JSON 字段含义：`type` 注册名 / `description` 能力说明 / `category` 分类 / `requires` 前置 context key / `provides` 执行后写入的 key / `retryable` 是否重试 / `timeout` 默认超时(ms)。

<!-- CATALOG_JSON_START -->
```json
[
  {
    "type": "parallel",
    "description": "并行执行多个子步骤，等待全部完成后汇总结果；子步骤使用独立 context 快照防并发冲突",
    "category": "flow-control",
    "requires": [],
    "provides": [],
    "retryable": false,
    "timeout": 30000
  },
  {
    "type": "conditional",
    "description": "条件分支：根据 context 动态选择执行 ifTrue 或 ifFalse 子步骤",
    "category": "flow-control",
    "requires": [],
    "provides": [],
    "retryable": false,
    "timeout": 30000
  },
  {
    "type": "transform",
    "description": "执行轻量数据转换函数 stepDef.run(context)，用于拼装或改写上下文数据",
    "category": "flow-control",
    "requires": [],
    "provides": [],
    "retryable": false,
    "timeout": 30000
  },
  {
    "type": "noop",
    "description": "空操作占位，直接返回，不修改 context；用于流程测试或临时跳过某步骤",
    "category": "flow-control",
    "requires": [],
    "provides": [],
    "retryable": false,
    "timeout": 30000
  },
  {
    "type": "skill-proxy",
    "description": "代理调用 OpenClaw Skill 生态能力，避免为每个外部能力单独实现 step",
    "category": "integration",
    "requires": [],
    "provides": [],
    "retryable": true,
    "timeout": 15000
  },
  {
    "type": "rag-query",
    "description": "对本地知识库进行向量检索，返回与 topic 相关的文档片段（向量召回 + BM25 重排）",
    "category": "retrieval",
    "requires": [
      "topic"
    ],
    "provides": [
      "ragResults"
    ],
    "retryable": true,
    "timeout": 20000
  },
  {
    "type": "topic",
    "description": "从用户输入中提炼清晰写作主题，作为后续检索与写作的上游输入（LLM）",
    "category": "content-creation",
    "requires": [
      "input"
    ],
    "provides": [
      "topic"
    ],
    "retryable": true,
    "timeout": 20000
  },
  {
    "type": "hotspot",
    "description": "从搜索结果或知识库中提炼热点话题与传播角度（LLM），已有实时热点时请用 fetch-hotspots 代替",
    "category": "content-creation",
    "requires": [],
    "provides": [
      "hotspot",
      "hotspotSuggestions"
    ],
    "retryable": true,
    "timeout": 30000
  },
  {
    "type": "write",
    "description": "根据选题与研究结果生成完整结构化文章（标题、摘要、分节、配图提示词等）",
    "category": "content-creation",
    "requires": [
      "selectedTopic",
      "research"
    ],
    "provides": [
      "article",
      "articleData",
      "articleJson"
    ],
    "retryable": true,
    "timeout": 60000
  },
  {
    "type": "polish",
    "description": "对已有文章进行润色：保持原意，提升可读性与段落结构（LLM）",
    "category": "content-creation",
    "requires": [
      "article"
    ],
    "provides": [
      "article"
    ],
    "retryable": true,
    "timeout": 60000
  },
  {
    "type": "publish",
    "description": "将文章写入 outbox 发布队列并触发即时发送，实际出站由 outbox worker 异步处理",
    "category": "output",
    "requires": [
      "article",
      "channelId",
      "_runId"
    ],
    "provides": [],
    "retryable": true,
    "timeout": 10000
  },
  {
    "type": "generate-topics",
    "description": "基于热点和用户需求，用 LLM 生成多个候选话题（含标题、简介、角度、评分）",
    "category": "content-creation",
    "requires": [
      "input",
      "hotspots"
    ],
    "provides": [
      "topics",
      "styleBrief",
      "topicCandidates"
    ],
    "retryable": true,
    "timeout": 40000
  },
  {
    "type": "select-topic",
    "description": "从候选话题中选择一个最合适的话题（支持用户显式选择、模型选择和评分回退）",
    "category": "content-creation",
    "requires": [
      "topics",
      "input"
    ],
    "provides": [
      "selectedTopic",
      "topic"
    ],
    "retryable": true,
    "timeout": 30000
  },
  {
    "type": "research",
    "description": "围绕已选话题做写作前研究，输出角度、事实点、大纲、风险提示等结构化结果（LLM）",
    "category": "content-creation",
    "requires": [
      "selectedTopic"
    ],
    "provides": [
      "research"
    ],
    "retryable": true,
    "timeout": 40000
  },
  {
    "type": "image-generate",
    "description": "根据选定话题自动匹配场景，生成封面图提示词和文章内插图提示词（无需调用图片 API）",
    "category": "content-creation",
    "requires": [
      "selectedTopic"
    ],
    "provides": [
      "coverPrompt",
      "inlineImages"
    ],
    "retryable": true,
    "timeout": 60000
  },
  {
    "type": "fetch-hotspots",
    "description": "实时抓取微博/头条/百度热搜，输出标准化热点列表（真实 API，失败自动降级为样本数据）",
    "category": "data-fetch",
    "requires": [],
    "provides": [
      "hotspots"
    ],
    "retryable": true,
    "timeout": 30000
  },
  {
    "type": "render-article",
    "description": "将结构化文章数据渲染为发布用 HTML 与 Markdown，并提取图片位信息",
    "category": "content-creation",
    "requires": [
      "articleData"
    ],
    "provides": [
      "finalMarkdown",
      "finalHtml",
      "images"
    ],
    "retryable": true,
    "timeout": 30000
  }
]
```
<!-- CATALOG_JSON_END -->

### 16.3 新增 Step 实施规范（当 catalog 无可用能力时）

当需求无法由现有 catalog 覆盖时，AI 必须先补齐能力，再做流程编排。最小动作清单如下：

1. 在 `steps/` 新增 `<type>.step.js`，实现 `execute(context)`，并在文件内声明清晰的 `requires/provides/retryable/timeout`。
2. 在 `steps/index.js` 的 `STEP_REGISTRY` 注册新 `type`，确保运行时可识别。
3. 若 step 输出为数组或原始值，要求 workflow 侧强制配置 `output` key；若输出对象，遵循 merge 语义。
4. 为新 step 增加最小可用验证（至少包含 requires 满足与核心输出结构校验）。
5. 执行 `node scripts/update-step-guide.js`，把新 step 同步到 §16.2 catalog。
6. 完成同步后再生成 workflow，并在 `dependencyCheck` 中引用该新 step 的 provides 来源。

> 禁止“先引用不存在 type，后补实现”的倒序编排。

### 16.4 生成 workflow 的输出格式

AI 根据用户需求生成 workflow 时，必须返回以下三段：

**① steps**（可直接放入 workflow 定义的 JSON 数组）

```json
[
  { “type”: “fetch-hotspots” },
  { “type”: “generate-topics” },
  { “type”: “select-topic” },
  { “type”: “research” },
  { “type”: “write” },
  { “type”: “publish” }
]
```

**② dependencyCheck**（逐步说明每步的 requires 来源，不满足时标注”不可编排”）

```
fetch-hotspots requires: []            -> 无前置依赖，直接可用
generate-topics requires: [input, hotspots]
  - input      -> 来自初始 context（内置）
  - hotspots   -> 来自 fetch-hotspots.provides
select-topic requires: [topics, input]
  - topics     -> 来自 generate-topics.provides
  - input      -> 来自初始 context（内置）
research requires: [selectedTopic]
  - selectedTopic -> 来自 select-topic.provides
write requires: [selectedTopic, research]
  - selectedTopic -> 来自 select-topic.provides
  - research      -> 来自 research.provides
publish requires: [article, channelId, _runId]
  - article    -> 来自 write.provides
  - channelId  -> 来自初始 context（内置）
  - _runId     -> 来自初始 context（内置）
```

**③ risks**（仅列出与当前流程直接相关的风险）

```
- fetch-hotspots 失败会降级为样本数据，不会中断流程
- write 的 requires 未满足时报 inputError 直接 DLQ，不重试
- publish 依赖 channelId，若事件来源没有 channelId 则流程失败
```

### 16.5 最小检查清单

生成或人工编写 workflow 后，必须逐条确认：

- [ ] 所有 `type` 均存在于 §16.2 catalog（新增 step 须先按 §16.3 完成实现与同步再引用）。
- [ ] 每一步 `requires` 都有明确上游来源（初始 context 或前序 provides）。
- [ ] 数组 / 原始值输出已配置 `stepDef.output`（对象输出则不需要）。
- [ ] flow-control step 不承担内容生产。
- [ ] 流程终点产出满足目标（如 `article` / `finalMarkdown` / publish 动作）。
- [ ] 涉及 `_config` 的读取已在 workflow 端注释消费方，在 step 端声明 `@workflow-config`。
- [ ] 若本次引入了新 step：`steps/index.js` 已注册，`update-step-guide.js` 已执行，catalog 已更新。

---

*文档最后更新：2026-04-23*

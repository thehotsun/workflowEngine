# Workflow Engine 部署与安装排障指南

> 适用版本：v1.3+
> 目标：本文档只包含**部署流程**和**安装常见问题**。

---

## 1. 部署前要求

- OS：Ubuntu 20.04+ / Debian 11+
- Node.js：**18 LTS 或 20 LTS**（推荐 20）
- 包管理器：pnpm 10+
- 系统依赖：`build-essential`、`python3`（用于原生模块编译）
- 网络：可访问百炼 API 和 OpenClaw 网关

---

## 2. 标准部署步骤（从 0 到可运行）

### 2.1 克隆项目

```bash
git clone <你的仓库地址> workflow-engine
cd workflow-engine
```

### 2.2 使用 Node 20 LTS

```bash
# 使用 nvm（推荐）
nvm install 20
nvm use 20
node -v
```

### 2.3 安装系统依赖

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
```

### 2.4 安装项目依赖（允许原生模块构建）

`better-sqlite3`、`sqlite-vec` 需要构建脚本，建议在 `package.json` 保留如下配置：

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3", "sqlite-vec"]
  }
}
```

然后安装：

```bash
pnpm install
```

### 2.5 验证 sqlite-vec 可用

```bash
node -e "const db=require('better-sqlite3')(':memory:'); require('sqlite-vec').load(db); console.log('sqlite-vec OK')"
```

期望输出：`sqlite-vec OK`

### 2.6 配置环境变量

```bash
cp .env.example .env
```

用任意编辑器打开 `.env`，逐项确认：

---

#### 服务基础

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 服务监听端口 |
| `NODE_ENV` | `development` | 生产填 `production` |

---

#### 阿里云百炼（必填，缺失服务无法启动）

| 变量 | 说明 |
|---|---|
| `BAILIAN_API_KEY` | 百炼控制台 → API Key，格式 `sk-...` |
| `BAILIAN_BASE_URL` | 固定值 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `BAILIAN_CHAT_MODEL` | 对话模型名，默认 `qwen-plus` |
| `BAILIAN_EMBED_MODEL` | 向量化模型名，默认 `text-embedding-v4`，需在百炼控制台开通 |

```env
BAILIAN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_CHAT_MODEL=qwen-plus
BAILIAN_EMBED_MODEL=text-embedding-v4
```

---

#### OpenClaw 网关（必填，缺失无法收发 QQ 消息）

| 变量 | 说明 |
|---|---|
| `OPENCLAW_BASE_URL` | OpenClaw 监听地址，本机部署一般是 `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw 控制台 → 设置 → 网关 Token；或查 `~/.openclaw/config.json` 的 `gatewayToken` |
| `OPENCLAW_WEBHOOK_SECRET` | 自定义随机字符串，需与 OpenClaw 插件侧配置的 `webhookSecret` 一致 |
| `OPENCLAW_DEFAULT_SESSION_KEY` | OpenClaw 会话标识，填 `main` 即可 |
| `OPENCLAW_ACCOUNT_ID` | 可留空；部分 OpenClaw 版本需要填账号 ID |

消息发送参数（与 OpenClaw `/tools/invoke` 接口对应，一般无需修改）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENCLAW_MESSAGE_TOOL` | `message` | 工具名 |
| `OPENCLAW_MESSAGE_ACTION` | `send` | 动作名 |
| `OPENCLAW_MESSAGE_TARGET_ARG` | `target` | 目标参数名 |
| `OPENCLAW_MESSAGE_CONTENT_ARG` | `content` | 内容参数名 |
| `OPENCLAW_MESSAGE_TARGET_PREFIX` | `qqbot:group:` | 消息目标前缀，群消息填 `qqbot:group:`，私聊填 `qqbot:c2c:` |
| `OPENCLAW_MESSAGE_CHANNEL` | `qqbot` | 渠道名 |

```env
OPENCLAW_BASE_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=<从 OpenClaw 控制台获取>
OPENCLAW_WEBHOOK_SECRET=<自定义随机字符串>
OPENCLAW_DEFAULT_SESSION_KEY=main
OPENCLAW_MESSAGE_TOOL=message
OPENCLAW_MESSAGE_ACTION=send
OPENCLAW_MESSAGE_TARGET_ARG=target
OPENCLAW_MESSAGE_CONTENT_ARG=content
OPENCLAW_MESSAGE_TARGET_PREFIX=qqbot:group:
OPENCLAW_MESSAGE_CHANNEL=qqbot
OPENCLAW_ACCOUNT_ID=
```

---

#### 定时任务（按需填写）

| 变量 | 说明 |
|---|---|
| `SCHEDULER_CHANNEL_ID` | 定时任务触发时发送消息的目标 channel，格式 `qqbot:c2c:<user_openid>` |
| `SCHEDULER_CRON` | cron 表达式，默认 `0 8 * * *`（每天 8 点） |
| `SCHEDULER_TEXT` | 触发工作流的文本内容 |

```env
SCHEDULER_CHANNEL_ID=qqbot:c2c:<你的 user_openid>
SCHEDULER_CRON=0 8 * * *
SCHEDULER_TEXT=定时内容生成任务
```

---

#### 数据库与知识库路径

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DB_PATH` | `./data/engine.db` | SQLite 数据库文件路径，目录不存在会自动创建 |
| `KNOWLEDGE_DIR` | `./knowledge` | 语料 `.md` 文件目录，向量化时从此目录读取 |

```env
DB_PATH=./data/engine.db
KNOWLEDGE_DIR=./knowledge
```

---

#### 并发控制（可选，有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAX_CONCURRENT_RUNS` | `5` | 同时运行的 workflow 数量上限 |
| `MAX_CONCURRENT_LLM_CALLS` | `3` | 同时发起的 LLM chat 请求数量上限 |
| `MAX_CONCURRENT_EMBED_CALLS` | `5` | 同时发起的 embedding 请求数量上限 |

```env
MAX_CONCURRENT_RUNS=5
MAX_CONCURRENT_LLM_CALLS=3
MAX_CONCURRENT_EMBED_CALLS=5
```

---

#### 熔断器（可选，有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | 连续失败次数触发熔断 |
| `CIRCUIT_BREAKER_RESET_MS` | `30000` | 熔断后多少毫秒自动重置（30 秒） |

```env
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_RESET_MS=30000
```

### 2.7 初始化目录

```bash
mkdir -p data knowledge
```

### 2.8 放置待向量化文档

- 默认目录：`knowledge/`
- 只会处理 `.md` 文件（支持子目录）

示例：

```text
knowledge/
├── doc-a.md
├── doc-b.md
└── sub/
    └── doc-c.md
```

### 2.9 执行向量化导入

```bash
node rag/ingest.js
# 或 pnpm run ingest
```

### 2.10 启动服务

**方式一：直接运行（调试用）**

```bash
pnpm start
# 或 node index.js
```

**方式二：PM2 守护进程（生产推荐）**

```bash
# 安装 PM2（全局，仅首次）
npm install -g pm2

# 创建日志目录
mkdir -p logs

# 启动（生产模式，从 .env 读取变量）
pnpm run pm2:start
# 或直接: pm2 start ecosystem.config.js --env production

# 开机自启（执行后按提示运行 sudo env ... pm2 startup 命令）
pm2 startup
pm2 save
```

**PM2 常用命令**

```bash
pnpm run pm2:status    # 查看进程状态
pnpm run pm2:logs      # 实时查看日志
pnpm run pm2:restart   # 重启（代码更新后）
pnpm run pm2:reload    # 零停机重载
pnpm run pm2:stop      # 停止
```

### 2.11 健康检查

```bash
curl http://localhost:3000/health
```

期望：`{"status":"ok"}`

---

## 3. 安装/部署常见问题

## 3.1 `Could not locate the bindings file`（better-sqlite3）

**现象**

```text
Error: Could not locate the bindings file
```

**原因**

- Node 版本过新（如 Node 24）
- 原生模块未成功编译

**处理**

```bash
nvm use 20
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

再次验证：

```bash
node -e "const db=require('better-sqlite3')(':memory:'); console.log('better-sqlite3 OK')"
```

---

## 3.2 `Ignored build scripts: better-sqlite3`（pnpm）

**现象**

```text
Ignored build scripts: better-sqlite3
```

**原因**

pnpm 安全策略阻止了依赖的 install script。

**处理（推荐）**

1) 在 `package.json` 中配置：

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3", "sqlite-vec"]
  }
}
```

2) 重装依赖：

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

安装日志中应看到 `better-sqlite3 ... Running install script`。

---

## 3.3 `vec0.so: cannot open shared object file` / `no such module: vec0`

**现象**

```text
sqlite-vec extension not loaded ... vec0.so: cannot open shared object file
SqliteError: no such module: vec0
```

**原因**

扩展加载方式不正确或系统无法找到 `.so`。

**处理**

- 确认代码使用：

```js
require('sqlite-vec').load(db)
```

- 不要依赖 `db.loadExtension('vec0')` 这种仅按系统库路径查找的方式。

- 再次验证：

```bash
node -e "const db=require('better-sqlite3')(':memory:'); require('sqlite-vec').load(db); console.log('sqlite-vec OK')"
```

---

## 3.4 向量化时报 400：`batch size is invalid, it should not be larger than 10`

**现象**

```text
InvalidParameter: batch size ... should not be larger than 10
```

**原因**

Embedding 批量请求超过百炼接口上限（10）。

**处理**

- 确认项目中 embedding 批大小为 `10`
- 更新后重新执行：

```bash
node rag/ingest.js
```

---

## 3.5 执行 `node rag/ingest.js` 没有过程日志

当前脚本默认只有结束时才输出成功/失败信息，处理中间是静默。

可用以下方式观察进度：

```bash
# 需要先安装 sqlite3 客户端
sudo apt-get update && sudo apt-get install -y sqlite3

# 观察已入库文档数
watch -n 3 'sqlite3 data/engine.db "SELECT COUNT(*) FROM knowledge_docs WHERE status='"'"'active'"'"';"'

# 观察向量条数
watch -n 3 'sqlite3 data/engine.db "SELECT COUNT(*) FROM knowledge_vectors;"'
```

---

## 3.6 `sqlite3: not found`

**处理**

```bash
sudo apt-get update && sudo apt-get install -y sqlite3
```

---

## 3.7 向量化后检索不到内容

按顺序检查：

1. `knowledge/` 下是否有 `.md` 文件
2. `node rag/ingest.js` 是否执行完成
3. `sqlite-vec` 验证命令是否输出 `sqlite-vec OK`
4. `.env` 的 `KNOWLEDGE_DIR` 是否与你实际目录一致

---

## 4. 最小可用检查清单

部署后至少确认：

- [ ] `node -v` 是 18/20 LTS
- [ ] `pnpm install` 时未忽略 `better-sqlite3` 构建脚本
- [ ] `sqlite-vec OK` 验证通过
- [ ] `knowledge/` 下有 `.md` 语料
- [ ] `node rag/ingest.js` 执行完成
- [ ] `curl http://localhost:3000/health` 返回 `{"status":"ok"}`

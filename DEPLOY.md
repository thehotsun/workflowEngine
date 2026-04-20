# 生产部署指南

> 适用版本：v1.3
> 更新时间：2026-04-20（v1.3 修复安全、并发语义、状态机一致性、依赖清理）
> 目标平台：Linux（WSL2 Ubuntu 22.04 / 独立 Linux 主机均适用）

---

## 一、架构审查结论

### 1.1 系统是否能跑通

**结论：主流程代码逻辑闭合，可跑通。v1.3 已修复全部 P0/P1 以及 v1.3 新发现的安全与运维问题，可正式部署生产。**

主链路 `webhook.js → event_inbox → index.js pollEvents → engine.handleEvent → dispatcher → steps → message_outbox → outbox-worker → openclaw/client` 全部有对应实现，无缺失模块。

### 1.2 Step 约束机制评估（v1.2）

| 机制 | 状态 | 说明 |
|---|---|---|
| 输入校验 | 完整 | 新增 `step.requires` / `stepDef.requires(dependsOn)` 统一前置校验，缺失即报错 |
| 输出写入 | 完整 | `stepDef.output` 或 `context.merge(output)` |
| 依赖声明 | 完整 | 支持在 step 类和 workflow step 定义中声明依赖 |
| 错误传播 | 完整 | throw → `withRetry` 指数退避 → `enqueueDlq` |
| 重试/超时 | 完整 | `executeWithTimeout` + `withRetry`，输入错误标记为不重试 |
| 中断恢复 | 完整 | `recoverRuns` 恢复时重建 conversation，保留多轮历史 |
| 状态一致性 | 可用 | 顶层 step 与子 step index 隔离，恢复位点计算不再污染 |
| 并发安全 | 可用 | `parallel` 子步骤使用 context 快照，避免并发写冲突 |

### 1.3 已修复问题（P0/P1）

- [x] **P0-1** outbox `sending` 卡死：启动时自动把超时 `sending` 重置为 `pending`
- [x] **P0-2** 并发限流未实现：`bailian.model.js` 的 `chat()` / `embedding()` 均受信号量限制
- [x] **P0-3** sqlite-vec 不可用时 RAG 崩溃：新增 `isVectorAvailable()`，自动降级 `textSearch`
- [x] **P1-1** conditional/parallel 子步骤 `stepIndex` 污染：子步骤改为负数 index 命名空间
- [x] **P1-2** `onError: notify-and-dlq` 未生效：engine 新增 `_handleOnError()`，失败会写 outbox 通知
- [x] **P1-3** `markFailed` 无错误原因：失败时写入关联 `workflow_runs.error`
- [x] **P1-4** 断点恢复 conversation 丢失：recover 时根据 event/channel 重建 conversation
- [x] **v1.3-1** `/events/manual` 无鉴权：复用 `verifyWebhookAuth`，与 openclaw 端点同等保护
- [x] **v1.3-2** `pollEvents` 串行且 `MAX_CONCURRENT_RUNS` 未使用：改为 `Promise.all` 并发，配置真正生效
- [x] **v1.3-3** 状态机校验不读 DB：`runWorkflow` / `recoverRuns` 所有转换前先 `getRunById` 读取真实状态
- [x] **v1.3-4** WAL 无定期 checkpoint：`scheduler.js` 新增每日凌晨 3 点自动 `PRAGMA wal_checkpoint(TRUNCATE)`
- [x] **v1.3-5** `cockatiel` 未使用依赖：已从 `package.json` 移除

---

## 二、部署前准备

### 2.1 服务器要求

| 项目 | 最低要求 |
|---|---|
| OS | Ubuntu 20.04+ / Debian 11+ |
| Node.js | 18 LTS 或 20 LTS |
| npm | 8+ |
| 磁盘 | ≥ 2 GB（知识库 SQLite 向量索引会膨胀） |
| 内存 | ≥ 512 MB（better-sqlite3 WAL + Node 堆） |
| 网络 | 能访问 `dashscope.aliyuncs.com`（百炼 API） |
| 网络 | 能访问 OpenClaw 网关（默认 `127.0.0.1:18789`） |

### 2.2 Node.js 安装（如未安装）

```bash
# 使用 nvm（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node -v   # 应输出 v20.x.x
```

### 2.3 sqlite-vec 扩展安装

sqlite-vec 是原生 C 扩展，必须与当前系统/Node.js 位数匹配。

```bash
# 方法一：通过 npm 包（推荐）
npm install sqlite-vec

# 安装后验证
node -e "const db=require('better-sqlite3')(':memory:'); require('sqlite-vec').load(db); console.log('sqlite-vec OK')"
```

如果 npm 方式不可用，参考 https://github.com/asg017/sqlite-vec 手动编译 `.so` 并在 `db.js` 中指定完整路径。

---

## 三、部署步骤

### 第 1 步：克隆代码

```bash
git clone <你的仓库地址> workflow-engine
cd workflow-engine
```

### 第 2 步：安装依赖

> ⚠️ `better-sqlite3` 需要 node-gyp 编译原生模块，确保已安装 build-essential。

```bash
# 安装编译工具（首次部署）
sudo apt-get update && sudo apt-get install -y build-essential python3

# 安装项目依赖
npm install

# 验证语法（全部应输出无错误）
node --check index.js
```

### 第 3 步：配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填写以下必填项（带 `*` 的不填则服务无法运行）：

```env
# === 服务基础 ===
PORT=3000
NODE_ENV=production

# === 阿里云百炼（必填 *）===
BAILIAN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_CHAT_MODEL=qwen-plus
BAILIAN_EMBED_MODEL=text-embedding-v4

# === OpenClaw 网关（必填 *）===
OPENCLAW_BASE_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=<从 OpenClaw 控制台获取>
OPENCLAW_WEBHOOK_SECRET=<自定义随机字符串，与 OpenClaw 插件侧保持一致>

# === QQ 消息发送配置（与 /tools/invoke 参数对应）===
OPENCLAW_DEFAULT_SESSION_KEY=main
OPENCLAW_MESSAGE_TOOL=message
OPENCLAW_MESSAGE_ACTION=send
OPENCLAW_MESSAGE_TARGET_ARG=target
OPENCLAW_MESSAGE_CONTENT_ARG=content
OPENCLAW_MESSAGE_TARGET_PREFIX=qqbot:group:
OPENCLAW_MESSAGE_CHANNEL=qqbot
OPENCLAW_ACCOUNT_ID=

# === 定时任务（按需填写）===
SCHEDULER_CHANNEL_ID=qqbot:c2c:<你的 user_openid>
SCHEDULER_CRON=0 8 * * *
SCHEDULER_TEXT=定时内容生成任务

# === 数据库路径 ===
DB_PATH=./data/engine.db
KNOWLEDGE_DIR=./knowledge

# === 并发控制 ===
MAX_CONCURRENT_RUNS=5
MAX_CONCURRENT_LLM_CALLS=3
MAX_CONCURRENT_EMBED_CALLS=5

# === 熔断器 ===
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_RESET_MS=30000
```

**获取 OPENCLAW_GATEWAY_TOKEN 步骤：**

1. 登录 OpenClaw 控制台 → 设置 → 网关 Token → 复制。
2. 或直接查看 OpenClaw 配置文件 `~/.openclaw/config.json` 中的 `gatewayToken` 字段。

### 第 4 步：初始化数据目录

```bash
mkdir -p data
# DB 文件会在首次 start 时自动创建，无需手动操作
# 确认进程用户对 data/ 有写权限
ls -la data/
```

### 第 5 步：部署 OpenClaw 插件

将 `openclaw/hooks/my-qq-filter.js` 复制到 OpenClaw 的 `plugins/` 目录，并在插件配置中设置：

```json
{
  "engineUrl": "http://127.0.0.1:3000",
  "webhookSecret": "<与 .env 中 OPENCLAW_WEBHOOK_SECRET 相同>"
}
```

重启 OpenClaw 使插件生效，确认日志中出现 `my-qq-filter registered`。

### 第 6 步：导入知识库（可选，首次或语料更新时执行）

将所有 `.md` 语料文件放入 `knowledge/` 目录，然后执行：

```bash
# 首次全量导入（约 70MB / 700 文件时，视 embedding API 速率需要 5~30 分钟）
node rag/ingest.js --dir ./knowledge

# 后续增量更新（只处理变化的文件）
node rag/ingest.js --dir ./knowledge
```

导入过程中会消耗百炼 embedding API 调用量，完成后查看日志确认 `indexed X docs`。

### 第 7 步：验证配置

```bash
# 测试百炼 API 连通性
node -e "
const { OpenAI } = require('openai');
const client = new OpenAI({ apiKey: process.env.BAILIAN_API_KEY, baseURL: process.env.BAILIAN_BASE_URL });
require('dotenv').config();
client.chat.completions.create({ model: process.env.BAILIAN_CHAT_MODEL || 'qwen-plus', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
  .then(r => console.log('百炼 OK:', r.choices[0].message.content))
  .catch(e => console.error('百炼 FAIL:', e.message));
"

# 测试 OpenClaw 网关连通性
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  http://127.0.0.1:18789/health
# 期望输出 200
```

### 第 8 步：启动服务

**方式 A：pm2（推荐生产使用）**

```bash
npm install -g pm2

# 启动
pm2 start index.js --name workflow-engine --node-args="--max-old-space-size=512"

# 设置开机自启
pm2 save
pm2 startup   # 按提示执行输出的 sudo 命令

# 查看状态
pm2 status
pm2 logs workflow-engine --lines 50
```

**方式 B：systemd**

创建 `/etc/systemd/system/workflow-engine.service`：

```ini
[Unit]
Description=Workflow Engine
After=network.target

[Service]
Type=simple
User=<你的部署用户>
WorkingDirectory=/path/to/workflow-engine
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
EnvironmentFile=/path/to/workflow-engine/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable workflow-engine
sudo systemctl start workflow-engine
sudo systemctl status workflow-engine
```

### 第 9 步：健康检查验证

```bash
curl http://localhost:3000/health
# 期望响应：{"status":"ok"}

# 发送一条手动测试事件（需要 OPENCLAW_WEBHOOK_SECRET 鉴权）
curl -X POST http://localhost:3000/events/manual \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <OPENCLAW_WEBHOOK_SECRET>" \
  -d '{
    "channelId": "qqbot:c2c:<your_openid>",
    "userId": "<your_openid>",
    "text": "帮我写一篇关于AI的文章"
  }'
# 期望响应：{"eventId":"..."}
```

---

## 四、生产配置调优

### 4.1 日志持久化

默认 pino 输出到 stdout，重启后丢失。生产建议接入日志系统：

```bash
# 方案 A：pm2 日志文件（简单）
pm2 start index.js --name workflow-engine --log /var/log/workflow-engine/app.log --merge-logs

# 方案 B：stdout 接 pino-roll 滚动文件
# 在 utils/logger.js 中将 transport 改为 pino-roll（需安装 pino-roll 包）

# 方案 C：直接接 journald（使用 systemd 时自动生效）
journalctl -u workflow-engine -f
```

### 4.2 SQLite WAL 定期 checkpoint

SQLite WAL 模式下 WAL 文件不自动 checkpoint，长期运行后读性能下降。

**v1.3 已内置自动 checkpoint**：`trigger/scheduler.js` 每天凌晨 3 点自动执行 `PRAGMA wal_checkpoint(TRUNCATE)`，无需额外配置。

如果你的部署环境需要自定义执行时间或手动触发，也可以直接执行：

```bash
sqlite3 /path/to/data/engine.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### 4.3 数据备份

```bash
# SQLite 热备份（不需要停服）
0 2 * * * sqlite3 /path/to/data/engine.db ".backup /backup/engine-$(date +\%Y\%m\%d).db"

# 保留最近 7 天
find /backup -name "engine-*.db" -mtime +7 -delete
```

### 4.4 知识库更新流程（上线后）

```bash
# 1. 将新/更新的 .md 文件放入 knowledge/ 目录
# 2. 执行增量导入（无需停服）
node rag/ingest.js --dir ./knowledge
# 3. 观察日志确认导入完成
```

---

## 五、监控与告警

### 5.1 关键指标（通过查询 SQLite 获取）

```bash
# 今日运行成功/失败数
sqlite3 data/engine.db "
SELECT status, count(*) as cnt
FROM workflow_runs
WHERE created_at > strftime('%s','now','-1 day') * 1000
GROUP BY status;
"

# 查看 DLQ 积压（表示有步骤持续失败）
sqlite3 data/engine.db "SELECT count(*) FROM dlq WHERE replayed_at IS NULL;"

# 查看 outbox 卡死消息（v1.2 启动时自动恢复，此查询用于异常确认）
sqlite3 data/engine.db "SELECT count(*) FROM message_outbox WHERE status='sending' AND created_at < (strftime('%s','now') - 300) * 1000;"
```

### 5.2 告警建议

| 指标 | 告警阈值 | 说明 |
|---|---|---|
| DLQ 条数 | > 10 | 有步骤持续失败，需人工介入 |
| outbox sending 超 5 分钟 | > 0 | v1.2 仍出现时表示自动恢复未覆盖，需排查 worker 与 DB 时钟 |
| workflow_runs failed 比例 | > 20% | 系统异常，检查百炼 API 限流 |
| 进程 CPU > 90% 持续 5 分钟 | - | 检查并发控制是否生效 |

### 5.3 DLQ 手动重放

目前 DLQ 无自动重放接口，需人工处理：

```bash
# 查看 DLQ 内容
sqlite3 data/engine.db "SELECT id, run_id, step_name, error, created_at FROM dlq WHERE replayed_at IS NULL LIMIT 20;"

# 标记为已处理（确认错误不可修复时）
sqlite3 data/engine.db "UPDATE dlq SET replayed_at = strftime('%s','now')*1000 WHERE id = '<id>';"
```

---

## 六、回滚方案

### 6.1 代码回滚

```bash
# 使用 pm2
pm2 stop workflow-engine
git checkout <上一个稳定 commit>
npm install
pm2 start workflow-engine

# 使用 systemd
sudo systemctl stop workflow-engine
git checkout <上一个稳定 commit>
npm install
sudo systemctl start workflow-engine
```

### 6.2 数据库回滚

> ⚠️ 当前无 down-migration 机制，schema 变更时需手动处理。

```bash
# 停服
pm2 stop workflow-engine

# 恢复备份（替换数据库文件）
cp /backup/engine-<日期>.db data/engine.db

# 重启
pm2 start workflow-engine
```

**重要提醒**：回滚数据库会丢失备份时间点之后的所有运行记录，需评估业务影响。

---

## 七、常见问题排查

| 症状 | 排查步骤 |
|---|---|
| 服务启动失败 | 检查 `.env` 是否存在且格式正确；检查 `data/` 目录写权限；运行 `node --check index.js` 验证语法 |
| QQ 消息收到但无响应 | 检查 `event_inbox` 是否有记录；检查 engine 日志中是否有 `matchWorkflow` 匹配日志；检查触发词是否匹配 article.flow.js 中的正则 |
| 百炼 API 报 401 | 检查 `BAILIAN_API_KEY` 是否正确；检查 `text-embedding-v4` 是否已在百炼控制台开通 |
| RAG 检索无结果 | 确认 `knowledge/` 目录有 `.md` 文件；确认已运行 `node rag/ingest.js`；确认 sqlite-vec 扩展加载成功（查看启动日志） |
| 消息发送出去但 QQ 收不到 | 检查 `message_outbox` 表中消息 status；检查 `OPENCLAW_GATEWAY_TOKEN` 是否有效；检查 `channelId` 格式是否正确（`qqbot:c2c:<openid>`） |
| 消息 status 卡在 sending | v1.2 已自动修复（启动时重置），如仍出现请重启服务触发恢复 |
| DLQ 持续增加 | 查看 `dlq.error` 字段判断失败原因；常见：百炼 API 限流超过上限、外部网络不通 |

---

## 八、已知风险与待修复清单

v1.3 已修复所有 P0/P1 以及当前优先级最高的安全项，当前无高优先级遗留风险。

以下为中低优先级改进点（可在稳定运行后按需推进）：

- [ ] DLQ 无自动重放接口，失败消息需人工处理（参考 §5.3）
- [ ] `GET /health` 只返回 `{status:'ok'}`，未探测 DB / OpenClaw 可用性

'use strict'

const fastify = require('fastify')({ logger: false })
const WorkflowEngine = require('./core/engine').WorkflowEngine
const { getPendingEvents, markFailed } = require('./persist/repos/event.repo')
const { mapToConversation } = require('./openclaw/session-mapper')
const eventsRoutes = require('./trigger/webhook')
const { startScheduler } = require('./trigger/scheduler')
const { startOutboxWorker } = require('./trigger/outbox-worker')
const logger = require('./utils/logger')
const { PORT, MAX_CONCURRENT_RUNS } = require('./config')

// 注册所有 workflow 定义
const workflows = [
  require('./workflows/article.flow'),
  // require('./workflows/analysis.flow'), // 后续添加
]

const engine = new WorkflowEngine({ workflows })

// Fastify: 支持读取 rawBody（用于 webhook 签名验证）
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body
  try {
    done(null, JSON.parse(body))
  } catch (err) {
    done(err)
  }
})

fastify.register(eventsRoutes, { engine })

// Event 消费循环：每秒轮询 event_inbox，异步执行 workflow
const POLL_INTERVAL_MS = 1000
let isProcessing = false

async function pollEvents() {
  if (isProcessing) return
  isProcessing = true

  try {
    const events = getPendingEvents(MAX_CONCURRENT_RUNS)
    await Promise.all(events.map(async (row) => {
      try {
        const payload = JSON.parse(row.payload_json)
        const conversation = mapToConversation({
          source: payload.source,
          channelId: payload.channelId,
          userId: payload.userId
        })

        await engine.handleEvent({ event: payload, conversation, inboxEventId: row.id })
      } catch (err) {
        logger.error({ eventId: row.id, err: err.message }, 'Event processing error')
        markFailed(row.id, err.message)
      }
    }))
  } catch (err) {
    logger.error({ err: err.message }, 'Event poll error')
  } finally {
    isProcessing = false
  }
}

async function start() {
  try {
    // 启动时恢复中断的 workflow runs
    await engine.recoverRuns()

    // 启动 HTTP 服务
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    logger.info(`Workflow Engine started on port ${PORT}`)

    // 启动事件轮询
    setInterval(pollEvents, POLL_INTERVAL_MS)

    // 启动 Outbox Worker
    startOutboxWorker()

    // 启动定时调度器
    startScheduler()
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to start engine')
    process.exit(1)
  }
}

process.on('SIGINT', async () => {
  logger.info('Shutting down...')
  await fastify.close()
  process.exit(0)
})

start()

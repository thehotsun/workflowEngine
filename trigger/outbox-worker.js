'use strict'

const EventEmitter = require('events')
const {
  getPendingMessages,
  markSending,
  markSent,
  markMessageRetry,
  markMessageFailed,
  resetStaleSendingMessages
} = require('../persist/repos/outbox.repo')
const openclawClient = require('../openclaw/client')
const logger = require('../utils/logger')

const POLL_INTERVAL_MS = 5000   // 兜底轮询间隔（降低到 5s，因为有事件驱动）
const MAX_SEND_RETRIES = 3

// 全局 EventEmitter，publish.step.js 可 emit 'new_message' 触发即时消费
const outboxEmitter = new EventEmitter()
outboxEmitter.setMaxListeners(20)

let _workerRunning = false

function startOutboxWorker() {
  // 启动时先恢复卡死消息，防止 sending 状态永久滞留
  const recovered = resetStaleSendingMessages(10 * 60 * 1000)
  if (recovered > 0) {
    logger.warn({ recovered }, 'Recovered stale sending outbox messages to pending')
  }

  // 事件驱动：新消息写入 outbox 后立即触发
  outboxEmitter.on('new_message', async () => {
    try {
      await processOutbox()
    } catch (err) {
      logger.error({ err: err.message }, 'Outbox worker (event) error')
    }
  })

  // 兜底轮询：防止事件丢失（进程重启、异常场景）
  setInterval(async () => {
    try {
      await processOutbox()
    } catch (err) {
      logger.error({ err: err.message }, 'Outbox worker (poll) error')
    }
  }, POLL_INTERVAL_MS)

  logger.info('Outbox worker started (event-driven + poll fallback)')
}

async function processOutbox() {
  if (_workerRunning) return
  _workerRunning = true
  try {
    const messages = getPendingMessages(10)
    for (const msg of messages) {
      const retries = (msg.retry_count || 0) + 1
      markSending(msg.id, retries)

      try {
        await openclawClient.sendMessage({ channelId: msg.channel_id, content: msg.content })
        markSent(msg.id)
        logger.info({ msgId: msg.id, channelId: msg.channel_id }, 'Message sent')
      } catch (err) {
        if (retries >= MAX_SEND_RETRIES) {
          markMessageFailed(msg.id, retries)
          logger.error({ msgId: msg.id, err: err.message }, 'Message send failed, max retries reached')
        } else {
          markMessageRetry(msg.id, retries)
          logger.warn({ msgId: msg.id, retries, err: err.message }, 'Message send failed, will retry')
        }
      }
    }
  } finally {
    _workerRunning = false
  }
}

module.exports = { startOutboxWorker, outboxEmitter }

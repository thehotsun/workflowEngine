'use strict'

const { normalizeWebhookPayload, verifyWebhookAuth } = require('../openclaw/adapter')
const { createEvent } = require('../persist/repos/event.repo')
const logger = require('../utils/logger')

async function eventsRoutes(fastify, opts) {
  const { engine } = opts
  // 接收 OpenClaw Webhook 推送
  fastify.post('/events/openclaw', {
    config: { rawBody: true }
  }, async (request, reply) => {
    if (!verifyWebhookAuth(request.headers || {})) {
      logger.warn('Webhook shared-secret verification failed')
      return reply.code(401).send({ ok: false, error: 'Unauthorized' })
    }

    const event = normalizeWebhookPayload(request.body)
    if (!event.text && !event.channelId && !event.sourceEventId) {
      return reply.code(400).send({ ok: false, error: 'Invalid payload' })
    }

    logger.info({ channelId: event.channelId, userId: event.userId, text: event.text?.slice(0, 50) }, '📥 收到消息')

    // 检查是否有等待用户输入的 workflow run；只有文本消息才能作为恢复输入
    if (event.text) {
      const resumedRunId = await engine.resumeRun(event.channelId, event.text)
      if (resumedRunId) {
        logger.info({ channelId: event.channelId, runId: resumedRunId }, '▶️ Workflow resumed from wait')
        return reply.code(200).send({ ok: true, eventId: null, resumedRunId })
      }
    }

    // 拦截器检查：复用 workflow trigger.match，不匹配任何流程则返回 eventId: null，
    // my-qq-filter 收到 null 不会阻止 openclaw 默认回复
    const interceptResult = engine.shouldProcessMessage(event)
    if (!interceptResult.allowed) {
      logger.info({ channelId: event.channelId, reason: interceptResult.reason }, '⏭️ 消息不进入引擎，交还 openclaw')
      return reply.code(200).send({ ok: true, eventId: null, reason: interceptResult.reason })
    }

    const eventId = createEvent({
      source: event.source,
      sourceEventId: event.sourceEventId,
      eventType: event.triggerType,
      payload: event   // eventId 由 engine 通过 inboxEventId 参数传递，payload 保持干净
    })

    logger.info({ eventId, channelId: event.channelId, triggerType: event.triggerType }, '✅ Event received from OpenClaw')
    return reply.code(202).send({ ok: true, eventId })
  })

  // 手动触发（调试用，需与 /events/openclaw 相同的 shared-secret 鉴权）
  fastify.post('/events/manual', async (request, reply) => {
    if (!verifyWebhookAuth(request.headers || {})) {
      logger.warn('Manual trigger auth failed')
      return reply.code(401).send({ ok: false, error: 'Unauthorized' })
    }

    const { text, channelId, userId } = request.body || {}
    if (!text) return reply.code(400).send({ error: 'text is required' })

    const event = {
      source: 'manual',
      sourceEventId: `manual_${Date.now()}`,
      triggerType: 'message',
      text,
      channelId: channelId || 'manual',
      userId: userId || 'manual'
    }

    const eventId = createEvent({
      source: event.source,
      sourceEventId: event.sourceEventId,
      eventType: event.triggerType,
      payload: event
    })

    return reply.code(202).send({ eventId })
  })

  fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }))
}

module.exports = eventsRoutes

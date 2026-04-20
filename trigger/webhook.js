'use strict'

const { normalizeWebhookPayload, verifyWebhookAuth } = require('../openclaw/adapter')
const { createEvent } = require('../persist/repos/event.repo')
const logger = require('../utils/logger')

async function eventsRoutes(fastify) {
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

    const eventId = createEvent({
      source: event.source,
      sourceEventId: event.sourceEventId,
      eventType: event.triggerType,
      payload: event   // eventId 由 engine 通过 inboxEventId 参数传递，payload 保持干净
    })

    logger.info({ eventId, channelId: event.channelId, triggerType: event.triggerType }, 'Event received from OpenClaw')
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

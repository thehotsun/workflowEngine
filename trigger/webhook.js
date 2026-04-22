'use strict'

const { normalizeWebhookPayload, verifyWebhookAuth } = require('../openclaw/adapter')
const { createEvent } = require('../persist/repos/event.repo')
const logger = require('../utils/logger')

// ==================== 消息过滤配置 ====================
const FILTER_CONFIG = {
  // 1. 关键词过滤：只处理包含这些词的消息（空数组=不过滤）
  includeKeywords: ['帮我', '请问', '怎么', '什么', '为什么', 'AI', 'ai', '写文章', '生成'],
  
  // 2. 黑名单：包含这些词不处理
  excludeKeywords: ['测试', 'debug', '哈哈', '呵呵', '111', '222'],
  
  // 3. 时间过滤：只在这个时间段处理（24 小时制）
  timeRange: {
    start: 8,   // 早上 8 点
    end: 23     // 晚上 11 点
  },
  
  // 4. 允许的用户列表（空数组=允许所有）
  allowedUsers: [],
  
  // 5. 规则开关
  rules: {
    enableKeywordFilter: false,  // ⚠️ 设为 true 启用关键词过滤
    enableTimeFilter: false,     // ⚠️ 设为 true 启用时间过滤
    enableUserFilter: false      // ⚠️ 设为 true 启用用户过滤
  }
}

// ==================== 过滤逻辑 ====================
function shouldProcessMessage(event) {
  const { text, userId, channelId } = event
  
  logger.info({ channelId, userId, text: text?.slice(0, 50) }, '📥 收到消息')
  
  // 规则 1: 关键词过滤
  if (FILTER_CONFIG.rules.enableKeywordFilter) {
    const { includeKeywords, excludeKeywords } = FILTER_CONFIG
    const textLower = (text || '').toLowerCase()
    
    // 白名单检查
    if (includeKeywords.length > 0) {
      const hasInclude = includeKeywords.some(k => textLower.includes(k.toLowerCase()))
      if (!hasInclude) {
        logger.info({ channelId, userId }, '⏭️ 跳过：不包含白名单关键词')
        return { allowed: false, reason: 'keyword_filter' }
      }
    }
    
    // 黑名单检查
    if (excludeKeywords.length > 0) {
      const hasExclude = excludeKeywords.some(k => textLower.includes(k.toLowerCase()))
      if (hasExclude) {
        logger.info({ channelId, userId }, '⏭️ 跳过：包含黑名单关键词')
        return { allowed: false, reason: 'blacklist' }
      }
    }
  }
  
  // 规则 2: 时间过滤
  if (FILTER_CONFIG.rules.enableTimeFilter) {
    const hour = new Date().getHours()
    const { start, end } = FILTER_CONFIG.timeRange
    
    if (hour < start || hour >= end) {
      logger.info({ channelId, userId, hour }, '⏭️ 跳过：非服务时间')
      return { allowed: false, reason: 'time_filter' }
    }
  }
  
  // 规则 3: 用户过滤
  if (FILTER_CONFIG.rules.enableUserFilter && FILTER_CONFIG.allowedUsers.length > 0) {
    if (!FILTER_CONFIG.allowedUsers.includes(userId)) {
      logger.info({ channelId, userId }, '⏭️ 跳过：用户不在白名单')
      return { allowed: false, reason: 'user_filter' }
    }
  }
  
  logger.info({ channelId, userId }, '✅ 通过过滤')
  return { allowed: true }
}

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

    // 🔍 消息过滤检查
    const filterResult = shouldProcessMessage(event)
    if (!filterResult.allowed) {
      logger.info({ 
        eventId: event.sourceEventId, 
        channelId: event.channelId, 
        reason: filterResult.reason 
      }, '🚫 消息被过滤')
      return reply.code(200).send({ 
        ok: true, 
        filtered: true, 
        reason: filterResult.reason,
        eventId: null 
      })
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

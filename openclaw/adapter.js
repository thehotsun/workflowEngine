'use strict'

const { OPENCLAW_WEBHOOK_SECRET } = require('../config')

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return null
}

// ─── 格式一：QQ Bot 原始事件（OpenClaw 内部日志格式，通过 hook 直接转发）─────────
// 结构: { t: 'C2C_MESSAGE_CREATE', d: { author, content, id, ... } }
const QQ_EVENT_CHAT_TYPE = {
  C2C_MESSAGE_CREATE:       'c2c',
  DIRECT_MESSAGE_CREATE:    'c2c',
  GROUP_AT_MESSAGE_CREATE:  'group',
  AT_MESSAGE_CREATE:        'channel',
  MESSAGE_CREATE:           'channel'
}

function extractQQBotChannelId(t, d = {}) {
  const chatType = QQ_EVENT_CHAT_TYPE[t]
  if (chatType === 'c2c') {
    const openId = d.author?.user_openid || d.author?.id
    if (openId) return `qqbot:c2c:${openId}`
  }
  if (chatType === 'group') {
    const groupId = d.group_openid || d.group_id
    if (groupId) return `qqbot:group:${groupId}`
  }
  if (chatType === 'channel') {
    if (d.channel_id) return `qqbot:channel:${d.channel_id}`
  }
  return null
}

function extractQQBotUserId(d = {}) {
  return pickFirst(d.author?.user_openid, d.author?.id, d.user_openid)
}

// ─── 格式二：OpenClaw internal hook 转发格式 ─────────────────────────────────
// hook 监听 message:received，把 event.context 包装成这个结构发过来
// 结构: {
//   hookEvent: 'message:received',
//   sessionKey: 'agent:main:qqbot:direct:xxx',
//   context: { from, content, channelId, messageId, metadata }
// }
function isHookForwardEvent(raw) {
  return !!(raw.hookEvent && raw.context && typeof raw.context === 'object')
}

function normalizeHookForwardEvent(raw) {
  const ctx = raw.context
  const sessionKey = raw.sessionKey || ''

  const channelId = pickFirst(
    ctx.channelId,
    ctx.target,
    sessionKeyToQQTarget(sessionKey)
  )

  const userId = pickFirst(
    ctx.from,
    ctx.metadata?.senderId,
    ctx.metadata?.user_openid
  )

  const sourceEventId = pickFirst(
    ctx.messageId,
    ctx.id,
    `hook_${raw.ts || Date.now()}`
  )

  return {
    eventId: sourceEventId,
    source: 'openclaw',
    sourceEventId,
    triggerType: 'message',
    userId,
    channelId,
    text: ctx.content ? String(ctx.content).trim() : '',
    metadata: {
      rawPayload: raw,
      receivedAt: Date.now(),
      qqEventType: null,
      hookEvent: raw.hookEvent,
      sessionKey,
      action: null,
      routeId: null,
      sessionId: sessionKey || null,
      flowId: null,
      taskId: null,
      runtime: null
    }
  }
}

function sessionKeyToQQTarget(sessionKey) {
  if (!sessionKey) return null
  // agent:<mainKey>:qqbot:<chatType>:<openId>
  const parts = sessionKey.split(':')
  if (parts.length < 5 || parts[2] !== 'qqbot') return null
  const typeMap = { direct: 'c2c', group: 'group', channel: 'channel' }
  const mapped = typeMap[parts[3]]
  if (!mapped) return null
  return `qqbot:${mapped}:${parts.slice(4).join(':')}`
}

// ─── 格式三：扁平结构（手动触发 / 其他外部系统 / qqbot-plugin 转发）─────────
// 兼容插件转发格式：{ source:'qqbot-plugin', channelId, userId, text, ts, metadata:{...} }
function normalizeGenericEvent(raw) {
  // messageId 可能在顶层或 metadata 中（插件格式）
  const meta = raw.metadata || {}
  const sourceEventId = pickFirst(
    raw.sourceEventId, raw.messageId, meta.messageId,
    raw.eventId, raw.id, raw?.data?.id
  )
  const channelId = pickFirst(
    raw.channelId, raw.target, raw.groupId,
    raw.sessionId, raw.conversationId, raw?.channel?.id
  )
  const userId = pickFirst(
    raw.userId, raw.senderId, raw.openId,
    raw?.sender?.id, raw?.author?.id, raw?.user?.id
  )
  const text = pickFirst(
    raw.text, raw.message, raw.content, raw.prompt,
    raw.goal, raw.task, raw?.data?.content, raw?.payload?.text
  )
  // sessionKey 可能在顶层或 metadata 中（插件格式）
  const sessionKey = pickFirst(raw.sessionKey, meta.sessionKey)

  return {
    eventId: pickFirst(raw.eventId, raw.id, sourceEventId),
    source: 'openclaw',
    sourceEventId,
    triggerType: pickFirst(raw.triggerType, raw.type, raw.action, 'message'),
    userId,
    channelId,
    text: text == null ? '' : String(text),
    metadata: {
      rawPayload: raw,
      receivedAt: Date.now(),
      qqEventType: null,
      hookEvent: null,
      sessionKey,
      action: raw.action || null,
      routeId: raw.routeId || null,
      sessionId: raw.sessionId || null,
      flowId: raw.flowId || null,
      taskId: raw.taskId || null,
      runtime: raw.runtime || null
    }
  }
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────
function normalizeWebhookPayload(raw = {}) {
  // 格式一：QQ Bot 原始事件 { t, d }
  if (raw.t && raw.d && typeof raw.d === 'object') {
    const d = raw.d
    const sourceEventId = pickFirst(d.id, raw.id)
    const channelId = extractQQBotChannelId(raw.t, d)
    const userId = extractQQBotUserId(d)
    const text = d.content ? String(d.content).trim() : ''

    return {
      eventId: pickFirst(raw.eventId, raw.id, sourceEventId),
      source: 'openclaw',
      sourceEventId,
      triggerType: 'message',
      userId,
      channelId,
      text,
      metadata: {
        rawPayload: raw,
        receivedAt: Date.now(),
        qqEventType: raw.t,
        hookEvent: null,
        sessionKey: null,
        action: null,
        routeId: null,
        sessionId: null,
        flowId: null,
        taskId: null,
        runtime: null
      }
    }
  }

  // 格式二：hook 转发格式 { hookEvent, sessionKey, context }
  if (isHookForwardEvent(raw)) {
    return normalizeHookForwardEvent(raw)
  }

  // 格式三：扁平通用格式
  return normalizeGenericEvent(raw)
}

// ─── 鉴权 ────────────────────────────────────────────────────────────────────
function extractBearerToken(headers = {}) {
  const authorization = headers.authorization || headers.Authorization
  if (!authorization || typeof authorization !== 'string') return ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function verifyWebhookAuth(headers = {}) {
  if (!OPENCLAW_WEBHOOK_SECRET) return true
  const bearerToken = extractBearerToken(headers)
  const secretHeader = headers['x-openclaw-webhook-secret'] || headers['X-OpenClaw-Webhook-Secret']
  const presentedSecret = bearerToken || secretHeader || ''
  return presentedSecret === OPENCLAW_WEBHOOK_SECRET
}

module.exports = { normalizeWebhookPayload, verifyWebhookAuth, sessionKeyToQQTarget }

'use strict'

const {
  OPENCLAW_BASE_URL,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_DEFAULT_SESSION_KEY,
  OPENCLAW_MESSAGE_TOOL,
  OPENCLAW_MESSAGE_ACTION,
  OPENCLAW_MESSAGE_TARGET_ARG,
  OPENCLAW_MESSAGE_CONTENT_ARG,
  OPENCLAW_MESSAGE_TARGET_PREFIX,
  OPENCLAW_MESSAGE_CHANNEL,
  OPENCLAW_ACCOUNT_ID,
  BAILIAN_API_KEY,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_RESET_MS
} = require('../config')
const logger = require('../utils/logger')

// QQ Bot API 配置（从 openclaw.json 读取）
const QQBOT_APP_ID = '1903535544'
const QQBOT_CLIENT_SECRET = 'HSQEzc3GIIFVl0CY'

// 简易熔断器实现（不依赖 cockatiel，保持零额外依赖）
const circuitBreaker = {
  failures: 0,
  state: 'closed',       // closed | open | half-open
  openAt: null,

  canRequest() {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (Date.now() - this.openAt >= CIRCUIT_BREAKER_RESET_MS) {
        this.state = 'half-open'
        return true
      }
      return false
    }
    return true // half-open: 试探一次
  },

  onSuccess() {
    this.failures = 0
    this.state = 'closed'
  },

  onFailure() {
    this.failures++
    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.state = 'open'
      this.openAt = Date.now()
      logger.warn({ failures: this.failures }, 'OpenClaw circuit breaker OPEN')
    }
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

function buildHeaders(extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders
  }

  if (OPENCLAW_GATEWAY_TOKEN) {
    headers.Authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`
  }

  if (OPENCLAW_MESSAGE_CHANNEL) {
    headers['x-openclaw-message-channel'] = OPENCLAW_MESSAGE_CHANNEL
  }

  if (OPENCLAW_ACCOUNT_ID) {
    headers['x-openclaw-account-id'] = OPENCLAW_ACCOUNT_ID
  }

  return headers
}

function buildInvokeBody({ tool, action, args = {}, sessionKey, dryRun = false }) {
  return {
    tool,
    ...(action ? { action } : {}),
    ...(args && Object.keys(args).length > 0 ? { args } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    dryRun
  }
}

const QQBOT_TARGET_PREFIXES = ['qqbot:c2c:', 'qqbot:group:', 'qqbot:channel:']

function buildMessageTarget(channelId) {
  if (!channelId) {
    throw new Error('sendMessage requires channelId')
  }

  // 已经是完整 qqbot target，直接用
  if (QQBOT_TARGET_PREFIXES.some(p => channelId.startsWith(p))) {
    return channelId
  }

  // 配置了前缀，拼接
  if (OPENCLAW_MESSAGE_TARGET_PREFIX) {
    return `${OPENCLAW_MESSAGE_TARGET_PREFIX}${channelId}`
  }

  // 没配置前缀，原样返回（适配未知格式或测试场景）
  return channelId
}

/**
 * 获取 QQ Bot Access Token
 */
async function getQQBotAccessToken() {
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: QQBOT_APP_ID,
      clientSecret: QQBOT_CLIENT_SECRET
    })
  })
  
  if (!res.ok) {
    throw new Error(`QQ Bot token request failed: ${res.status}`)
  }
  
  const data = await res.json()
  if (!data.access_token) {
    throw new Error('QQ Bot token response missing access_token')
  }
  
  return data.access_token
}

/**
 * 通过 QQ Bot API 发送主动消息（C2C 私聊）
 */
async function sendQQBotC2CMessage(accessToken, openid, content) {
  const url = `https://api.sgroup.qq.com/v2/users/${openid}/messages`
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `QQBot ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content,
      msg_type: 0,  // 文本消息
      msg_id: '',   // 主动消息不需要 msg_id
      event_id: ''
    })
  })
  
  if (!res.ok) {
    const error = await res.text().catch(() => 'unknown error')
    throw new Error(`QQ Bot send message failed: ${res.status} ${error}`)
  }
  
  return res.json()
}

/**
 * 通过 QQ Bot API 发送主动消息（群聊）
 */
async function sendQQBotGroupMessage(accessToken, groupOpenid, content) {
  const url = `https://api.sgroup.qq.com/v2/groups/${groupOpenid}/messages`
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `QQBot ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content,
      msg_type: 0,  // 文本消息
      msg_id: '',   // 主动消息不需要 msg_id
      event_id: ''
    })
  })
  
  if (!res.ok) {
    const error = await res.text().catch(() => 'unknown error')
    throw new Error(`QQ Bot send group message failed: ${res.status} ${error}`)
  }
  
  return res.json()
}

function sessionKeyToTarget(sessionKey) {
  if (!sessionKey) return null

  // sessionKey 格式: agent:<mainKey>:qqbot:<chatType>:<openId>
  // chatType: direct → c2c, group → group, channel → channel
  const parts = sessionKey.split(':')
  if (parts.length < 5 || parts[2] !== 'qqbot') return null

  const chatType = parts[3]
  const openId = parts.slice(4).join(':')

  const typeMap = { direct: 'c2c', group: 'group', channel: 'channel' }
  const mapped = typeMap[chatType]
  if (!mapped) return null

  return `qqbot:${mapped}:${openId}`
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!circuitBreaker.canRequest()) {
    throw new Error('OpenClaw circuit breaker is open, skipping request')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`OpenClaw HTTP ${res.status}: ${text}`)
      circuitBreaker.onFailure()
      throw err
    }

    circuitBreaker.onSuccess()
    return res
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`OpenClaw request timed out after ${timeoutMs}ms`)
      circuitBreaker.onFailure()
      throw timeoutErr
    }
    circuitBreaker.onFailure()
    throw err
  }
}

async function invokeTool(tool, args = {}, options = {}) {
  const {
    action,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sessionKey = OPENCLAW_DEFAULT_SESSION_KEY || undefined,
    dryRun = false,
    headers = {}
  } = options

  const res = await fetchWithTimeout(
    `${OPENCLAW_BASE_URL}/tools/invoke`,
    {
      method: 'POST',
      headers: buildHeaders(headers),
      body: JSON.stringify(buildInvokeBody({ tool, action, args, sessionKey, dryRun }))
    },
    timeoutMs
  )

  return res.json()
}

/**
 * 通过 QQ Bot API 发送 QQ 消息（主动消息）
 * 
 * 支持 C2C 私聊和群聊
 */
async function sendMessage({ channelId, content, sessionKey, timeoutMs = 10_000 }) {
  const resolvedTarget = buildMessageTarget(channelId || sessionKeyToTarget(sessionKey))
  
  logger.info({ target: resolvedTarget, content: content.slice(0, 50) }, '📤 发送 QQ 消息')
  
  try {
    // 解析 target 格式：qqbot:c2c:openid 或 qqbot:group:groupid
    const match = resolvedTarget.match(/^qqbot:(c2c|group|channel):(.+)$/i)
    if (!match) {
      throw new Error(`Invalid QQ Bot target format: ${resolvedTarget}`)
    }
    
    const [, type, openId] = match
    
    // 获取 access token
    const accessToken = await getQQBotAccessToken()
    
    // 根据类型发送消息
    let result
    if (type === 'c2c') {
      result = await sendQQBotC2CMessage(accessToken, openId, content)
    } else if (type === 'group') {
      result = await sendQQBotGroupMessage(accessToken, openId, content)
    } else {
      throw new Error(`QQ Bot message type not supported: ${type}`)
    }
    
    logger.info({ channelId: resolvedTarget, messageId: result.id }, '✅ QQ 消息发送成功')
    
    return {
      ok: true,
      messageId: result.id,
      timestamp: result.timestamp
    }
    
  } catch (err) {
    logger.error({ channelId: resolvedTarget, err: err.message }, '❌ QQ 消息发送失败')
    throw err
  }
}

module.exports = { invokeTool, sendMessage, buildMessageTarget, sessionKeyToTarget }

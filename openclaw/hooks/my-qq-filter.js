'use strict'

/**
 * my-qq-filter - 使用官方 message_received hook 转发 QQ 消息到工作流引擎
 *
 * 验收标准：
 * - 捕获 QQ 入站原始事件
 * - 标准化输出 payload (source/channelId/userId/text/ts/metadata)
 * - 每条消息只转发一次，带可追踪上下文 (peerId/peerKind/accountId/sessionKey/messageId)
 * - 异常处理完善，诊断日志清晰
 */

const WORKFLOW_ENGINE_URL =
  process.env.WORKFLOW_ENGINE_URL || 'http://127.0.0.1:3000/events/openclaw'
const WORKFLOW_ENGINE_SECRET = process.env.WORKFLOW_ENGINE_SECRET || ''

// 去重缓存：messageId -> timestamp，防止重复转发
const forwardedMessages = new Map()
const DEDUPE_TTL_MS = 60 * 1000 // 1 分钟

// 路由上下文缓存：sessionKey -> routing info
const routeContextBySession = new Map()
const ROUTE_CONTEXT_TTL_MS = 5 * 60 * 1000

/**
 * 清理过期缓存
 */
function pruneCache() {
  const now = Date.now()
  for (const [key, ts] of forwardedMessages.entries()) {
    if (now - ts > DEDUPE_TTL_MS) forwardedMessages.delete(key)
  }
  for (const [key, ctx] of routeContextBySession.entries()) {
    if (now - (ctx.ts || 0) > ROUTE_CONTEXT_TTL_MS)
      routeContextBySession.delete(key)
  }
}

/**
 * 构建频道 ID
 */
function buildChannelId(peerId, peerKind) {
  const kindMap = { direct: 'c2c', group: 'group', channel: 'channel' }
  return `qqbot:${kindMap[peerKind] || peerKind}:${peerId}`
}

/**
 * 检查是否已转发（去重）
 */
function isDuplicate(messageId) {
  if (!messageId) return false
  if (forwardedMessages.has(messageId)) return true
  forwardedMessages.set(messageId, Date.now())
  pruneCache()
  return false
}

/**
 * 转发消息到工作流引擎
 * 返回：{ forwarded: bool, eventId: string|null }
 *   - forwarded: 是否成功转发
 *   - eventId: 引擎返回的 eventId，非 null 表示流程已接管该消息
 */
async function forward(payload) {
  const headers = { 'Content-Type': 'application/json' }
  if (WORKFLOW_ENGINE_SECRET) {
    headers.Authorization = `Bearer ${WORKFLOW_ENGINE_SECRET}`
  }

  try {
    const res = await fetch(WORKFLOW_ENGINE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[my-qq-filter] ❌ 转发失败 HTTP ${res.status}: ${text}`)
      return { forwarded: false, eventId: null }
    }

    const data = await res.json().catch(() => ({}))
    const eventId = data.eventId || null

    console.log(
      `[my-qq-filter] ✅ 转发成功: ${payload.channelId} | "${payload.text.slice(0, 50)}..." | eventId=${eventId}`,
    )
    return { forwarded: true, eventId }
  } catch (err) {
    console.error(`[my-qq-filter] ❌ 转发异常: ${err.message}`)
    return { forwarded: false, eventId: null }
  }
}

/**
 * 标准化 payload 构建
 */
function buildPayload(event, ctx) {
  const metadata = event.metadata || {}

  // ✅ 修复 Bug 1: 优先使用 conversationId 作为 channelId
  let channelId = ctx.conversationId || ctx.channelId

  // ✅ 修复 Bug 2: 优先使用 senderId 作为 peerId (裸 openid)
  const peerId = metadata.senderId || metadata.peerId || metadata.from
  const peerKind = metadata.peerKind || 'direct'
  const accountId = ctx.accountId || metadata.accountId
  const messageId = metadata.messageId || metadata.id
  const sessionKey = metadata.sessionKey || ctx.conversationId

  // 如果 channelId 仍然是 "qqbot" 这种 provider 名称，用 peerId 构建完整格式
  if (!channelId || channelId === 'qqbot') {
    channelId = buildChannelId(peerId, peerKind)
  }

  // 提取用户 ID (使用裸 peerId)
  const userId = peerId

  // 提取消息文本
  const text = String(event.content || '').trim()

  if (!channelId || !text) {
    console.log(
      `[my-qq-filter] ⚠️ 跳过无效消息: channelId=${channelId}, text="${text}"`,
    )
    return null
  }

  return {
    source: 'qqbot-plugin',
    channelId,
    userId,
    text,
    ts: event.timestamp || Date.now(),
    metadata: {
      peerId,
      peerKind,
      accountId,
      messageId,
      sessionKey,
      qqEventType: metadata.qqEventType || metadata.eventType || 'unknown',
      conversationId: ctx.conversationId,
      pluginId: 'my-qq-filter',
      pluginVersion: '1.0.0',
    },
  }
}

/**
 * 插件入口
 */
module.exports = function register(api) {
  const logger = api.logger || console

  logger.info('[my-qq-filter] 🚀 插件初始化')
  logger.info(`[my-qq-filter] 📡 工作流引擎地址：${WORKFLOW_ENGINE_URL}`)
  logger.info(
    `[my-qq-filter] 🔐 鉴权配置：${WORKFLOW_ENGINE_SECRET ? '已配置' : '未配置'}`,
  )

  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ 官方 API: message_received hook
  // ─────────────────────────────────────────────────────────────────────────────

  if (typeof api.on === 'function') {
    try {
      api.on('message_received', async (event, ctx) => {
        try {
          logger.info(
            '[my-qq-filter] ╔═══════════════════════════════════════════════════════════════',
          )
          logger.info('[my-qq-filter] 📥 message_received 触发')
          logger.info(
            '[my-qq-filter] ───────────────────────────────────────────────────────────────',
          )
          logger.info('[my-qq-filter] 【EVENT 完整内容】:')
          logger.info(JSON.stringify(event, null, 2))
          logger.info(
            '[my-qq-filter] ───────────────────────────────────────────────────────────────',
          )
          logger.info('[my-qq-filter] 【CTX 完整内容】:')
          logger.info(JSON.stringify(ctx, null, 2))
          logger.info(
            '[my-qq-filter] ───────────────────────────────────────────────────────────────',
          )
          logger.info(`[my-qq-filter] 提取关键信息:`)
          logger.info(`[my-qq-filter]   from: ${event.from}`)
          logger.info(`[my-qq-filter]   content: "${event.content}"`)
          logger.info(`[my-qq-filter]   timestamp: ${event.timestamp}`)
          logger.info(
            `[my-qq-filter]   metadata: ${JSON.stringify(event.metadata || {})}`,
          )
          logger.info(`[my-qq-filter]   ctx.channelId: ${ctx?.channelId}`)
          logger.info(`[my-qq-filter]   ctx.accountId: ${ctx?.accountId}`)
          logger.info(
            `[my-qq-filter]   ctx.conversationId: ${ctx?.conversationId}`,
          )
          logger.info(
            '[my-qq-filter] ╚═══════════════════════════════════════════════════════════════',
          )

          // 去重检查
          const messageId = event.metadata?.messageId || event.metadata?.id
          if (isDuplicate(messageId)) {
            logger.debug(`[my-qq-filter] ⏭️ 跳过重复消息: ${messageId}`)
            return
          }

          // 构建标准化 payload
          const payload = buildPayload(event, ctx)
          if (!payload) {
            logger.warn('[my-qq-filter] ⚠️ 无法构建 payload，跳过')
            return
          }

          // 转发到工作流引擎
          const { forwarded, eventId } = await forward(payload)

          // 如果流程引擎接管了这条消息（返回了 eventId），阻止 openclaw 自动回复
          if (forwarded && eventId) {
            logger.info(`[my-qq-filter] 🛑 流程已接管消息 (eventId=${eventId})，阻止 openclaw 默认回复`)
            return false
          }
        } catch (err) {
          logger.error(
            `[my-qq-filter] ❌ message_received 处理异常: ${err.message}`,
          )
          logger.error(err.stack)
        }
      })

      logger.info('[my-qq-filter] ✅ 已注册 message_received hook')
    } catch (err) {
      logger.error(
        `[my-qq-filter] ❌ 注册 message_received hook 失败：${err.message}`,
      )
    }
  } else {
    logger.error('[my-qq-filter] ❌ api.on 不可用，无法注册 hook')
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 🔧 兼容模式：如果 qqbot 插件传递原始 { t, d } 事件，也进行拦截
  // ─────────────────────────────────────────────────────────────────────────────

  const runtime = api.runtime
  if (runtime?.channel?.routing) {
    try {
      // 缓存路由上下文
      const originalResolveAgentRoute =
        runtime.channel.routing.resolveAgentRoute
      runtime.channel.routing.resolveAgentRoute = function (params) {
        const result = originalResolveAgentRoute.call(this, params)

        if (params.channel === 'qqbot' && result?.sessionKey) {
          const peerId = params.peer?.id || params.peer?.peerId
          const peerKind = params.peer?.kind || 'direct'
          const accountId = params.accountId

          routeContextBySession.set(result.sessionKey, {
            ts: Date.now(),
            channelId: buildChannelId(peerId, peerKind),
            peerId,
            peerKind,
            accountId,
          })
          pruneCache()
        }

        return result
      }
      logger.info('[my-qq-filter] ✅ 已安装路由上下文缓存')
    } catch (err) {
      logger.error(`[my-qq-filter] ❌ 路由拦截安装失败：${err.message}`)
    }
  }

  logger.info('[my-qq-filter] 🎉 插件加载完成')
}

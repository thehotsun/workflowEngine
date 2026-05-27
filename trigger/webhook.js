'use strict'

const { normalizeWebhookPayload, verifyWebhookAuth } = require('../openclaw/adapter')
const { createEvent } = require('../persist/repos/event.repo')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('./outbox-worker')
const logger = require('../utils/logger')

// ── 英文命令(. 或 / 前缀均可;. 在九宫格主键盘无需切换)───────
const CMD_HELP_RE       = /^[/.]workflow_help$/i
const CMD_LIST_RE       = /^[/.]workflow_list$/i
const CMD_CANCEL_ALL_RE = /^[/.]workflow_cancel\s+all$/i
const CMD_CANCEL_RE     = /^[/.]workflow_cancel(\s|$)/i
const CMD_RESUME_RE     = /^[/.]workflow_resume/i

// ── 中文命令(收紧匹配,减少误触)─────────────────────────────────
const HELP_RE          = /^(帮助|help)$/i
const LIST_PAUSED_RE   = /^查看\s*(中断|暂停|等待|流程)/i
const RESUME_RE        = /^恢复(\s*(流程|[1-9]\d*|run_[a-z0-9]+))?$/i
const CANCEL_RE        = /^(取消|删除)(\s*(流程|[1-9]\d*|run_[a-z0-9]+))?$/i

// OpenClaw 系统命令列表（不含引擎自己的 .workflow_help/.workflow_list/.workflow_cancel/.workflow_resume）
// 来源:openclaw docs/tools/slash-commands.md
const OPENCLAW_COMMANDS = new Set([
  // 核心命令
  'new', 'reset', 'compact', 'stop', 'session',
  'think', 'thinking', 't',
  'verbose', 'v', 'trace', 'fast',
  'reasoning', 'reason', 'elevated', 'elev',
  'exec', 'model', 'models', 'queue',
  'help', 'commands', 'tools', 'status',
  'tasks', 'context', 'export-session', 'export',
  'whoami', 'id', 'skill',
  'allowlist', 'approve', 'btw',
  'subagents', 'acp', 'focus', 'unfocus', 'agents',
  'kill', 'steer', 'tell',
  'config', 'mcp', 'plugins', 'plugin', 'debug',
  'usage', 'tts', 'restart', 'activation', 'send',
  'bash',
  // 插件命令
  'dreaming', 'pair', 'phone', 'voice', 'card', 'codex',
  // QQBot
  'bot-ping', 'bot-version', 'bot-help', 'bot-upgrade', 'bot-logs',
])

function _isOpenClawCommand(text) {
  const match = text.match(/^\/?([a-z][a-z0-9_-]*)/i)
  if (!match) return false
  const cmd = match[1].toLowerCase()
  return OPENCLAW_COMMANDS.has(cmd)
}
const CANCEL_ALL_RE    = /^(取消|删除)\s*(全部|所有|all)/i

/**
 * 从文本中解析操作人指定的 runId
 * 支持两种格式:
 *   - run_xxx  → 直接返回该 runId 字符串
 *   - 纯数字 N → 取 runs 列表第 N 项(1-based)的 runId
 * @param {string} text
 * @param {Array}  runs - engine.getWaitingRuns() 返回的列表(已排序)
 * @returns {string|null}
 */
function resolveTargetRun(text, runs) {
  const byId = text.match(/run_[a-z0-9]+/i)
  if (byId) return byId[0]
  const byOrdinal = text.match(/\b([1-9]\d*)\b/)
  if (byOrdinal) {
    const idx = parseInt(byOrdinal[1], 10) - 1
    return runs[idx]?.runId || null
  }
  return null
}

/**
 * 将中断列表格式化为可读文本并通过 outbox 发送给用户
 */
function sendPausedList(channelId, runs, enqueue) {
  if (!runs.length) {
    const content = '当前没有中断的流程。'
    const msgId = enqueue({ runId: null, channelId, content })
    outboxEmitter.emit('new_message', { msgId, runId: null })
    return
  }
  const lines = ['当前中断的流程:']
  runs.forEach((r, i) => {
    const ts = new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })
    const reason = r.pauseReason ? `\n   原因:${r.pauseReason}` : ''
    lines.push(`${i + 1}. [${r.workflowName}] 卡在步骤「${r.stepName || '?'}」 (${ts})${reason}\n   runId:${r.runId}`)
  })
  lines.push('\n回复 .workflow_resume 1 恢复,.workflow_cancel 1 取消,.workflow_cancel all 清空,.workflow_help 查看命令。')
  const content = lines.join('\n')
  const msgId = enqueue({ runId: null, channelId, content })
  outboxEmitter.emit('new_message', { msgId, runId: null })
}

async function eventsRoutes(fastify, opts) {
  const { engine } = opts

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

    const text = event.text || ''
    const channelId = event.channelId

    // ── 0. 操作人指令：帮助（.workflow_help / 帮助）────────────────
    if (text && (HELP_RE.test(text) || CMD_HELP_RE.test(text))) {
      logger.info({ channelId }, '📖 帮助指令')
      const helpContent = [
        '📖 可用命令(. 和 / 等效,九宫格推荐用 .)',
        '',
        '  .workflow_list        查看暂停的流程',
        '  .workflow_resume 1    恢复第 1 个流程',
        '  .workflow_cancel 1    取消第 1 个流程',
        '  .workflow_cancel all  取消全部暂停的流程',
        '  .workflow_help        显示此帮助',
        '',
        '中文命令:恢复 1 | 取消 1 | 取消全部 | 查看流程 | 帮助',
      ].join('\n')
      const msgId = enqueueMessage({ runId: null, channelId, content: helpContent })
      outboxEmitter.emit('new_message', { msgId, runId: null })
      return reply.code(200).send({ ok: true, eventId: null, handled: 'help' })
    }

    // ── 1. 操作人指令：查看中断流程（.workflow_list / 查看流程）────
    if (text && (LIST_PAUSED_RE.test(text) || CMD_LIST_RE.test(text))) {
      logger.info({ channelId, text: text.slice(0, 50) }, '📋 查看中断流程指令')
      const runs = engine.getWaitingRuns(channelId)
      sendPausedList(channelId, runs, enqueueMessage)
      return reply.code(200).send({ ok: true, eventId: null, handled: 'list_paused' })
    }

    // ── 1.5. 操作人指令：取消全部（.workflow_cancel all / 取消全部）────
    if (text && (CANCEL_ALL_RE.test(text) || CMD_CANCEL_ALL_RE.test(text))) {
      logger.info({ channelId, text: text.slice(0, 50) }, '🗑️ 取消全部流程指令')
      const runs = engine.getWaitingRuns(channelId)
      if (!runs.length) {
        const msgId = enqueueMessage({ runId: null, channelId, content: '当前没有中断的流程。' })
        outboxEmitter.emit('new_message', { msgId, runId: null })
      } else {
        let cancelled = 0
        for (const r of runs) {
          if (engine.cancelRun(r.runId)) cancelled++
        }
        const content = `已取消 ${cancelled} 个流程。`
        const msgId = enqueueMessage({ runId: null, channelId, content })
        outboxEmitter.emit('new_message', { msgId, runId: null })
        logger.info({ channelId, cancelled, total: runs.length }, '🗑️ Cancel all result')
      }
      return reply.code(200).send({ ok: true, eventId: null, handled: 'cancel_all' })
    }

    // ── 2. 操作人指令：取消/删除中断流程（.workflow_cancel / 取消）─────
    if (text && (CANCEL_RE.test(text) || CMD_CANCEL_RE.test(text))) {
      logger.info({ channelId, text: text.slice(0, 50) }, '🗑️ 取消流程指令')
      const runs = engine.getWaitingRuns(channelId)
      const targetRunId = resolveTargetRun(text, runs)
      if (targetRunId) {
        const ok = engine.cancelRun(targetRunId)
        const content = ok
          ? `流程 ${targetRunId} 已取消。`
          : `未找到可取消的流程 ${targetRunId}(可能已完成或不存在)。`
        const msgId = enqueueMessage({ runId: null, channelId, content })
        outboxEmitter.emit('new_message', { msgId, runId: null })
        logger.info({ channelId, runId: targetRunId, ok }, '🗑️ Cancel run result')
        return reply.code(200).send({ ok: true, eventId: null, handled: 'cancel_run', cancelled: ok })
      }
      // 没有 runId:先列出,提示用户指定
      if (!runs.length) {
        const msgId = enqueueMessage({ runId: null, channelId, content: '当前没有中断的流程可以取消。' })
        outboxEmitter.emit('new_message', { msgId, runId: null })
      } else {
        sendPausedList(channelId, runs, enqueueMessage)
        const hint = enqueueMessage({ runId: null, channelId, content: '请回复 .workflow_cancel 1 或 .workflow_cancel run_xxx 指定要取消的流程。' })
        outboxEmitter.emit('new_message', { msgId: hint, runId: null })
      }
      return reply.code(200).send({ ok: true, eventId: null, handled: 'cancel_needs_runid' })
    }

    // ── 3. 操作人指令：恢复指定（或最新）中断流程（.workflow_resume / 恢复）─
    if (text && (RESUME_RE.test(text) || CMD_RESUME_RE.test(text))) {
      logger.info({ channelId, text: text.slice(0, 50) }, '▶️ 恢复流程指令')
      const runs = engine.getWaitingRuns(channelId)
      const targetRunId = resolveTargetRun(text, runs) || undefined
      const resumedRunId = await engine.resumeRun(channelId, text, targetRunId)
      if (resumedRunId) {
        logger.info({ channelId, runId: resumedRunId }, '▶️ Workflow operator-resumed')
        return reply.code(200).send({ ok: true, eventId: null, resumedRunId, handled: 'operator_resume' })
      }
      // 没有可恢复的流程,告知用户,仍拦截不转给 openclaw
      const msgId = enqueueMessage({ runId: null, channelId, content: '当前没有中断的流程可以恢复。' })
      outboxEmitter.emit('new_message', { msgId, runId: null })
      return reply.code(200).send({ ok: true, eventId: null, handled: 'no_waiting_run' })
    }

    // ── 4. 普通文本:检查是否有 user_input 类型的 waiting run ──────
    if (text) {
      // 以 / 开头的是 OpenClaw 系统命令,不作为工作流用户输入
      if (text.startsWith('/') && _isOpenClawCommand(text)) {
        logger.info({ channelId, text: text.slice(0, 30) }, '⏭️ 系统命令,不作为工作流用户输入,交还 openclaw')
        return reply.code(200).send({ ok: true, eventId: null, reason: 'system_command' })
      }
      const waitingRuns = engine.getWaitingRuns(channelId)
      const userInputRun = waitingRuns.find(r => r.waitType === 'user_input')
      if (userInputRun) {
        const resumedRunId = await engine.resumeRun(channelId, text, userInputRun.runId)
        if (resumedRunId) {
          logger.info({ channelId, runId: resumedRunId }, '▶️ Workflow user-input resumed')
          return reply.code(200).send({ ok: true, eventId: null, resumedRunId, handled: 'user_input_resume' })
        }
      }
    }

    // ── 5. 检查是否能触发新流程(拦截器) ────────────────────────────
    const interceptResult = engine.shouldProcessMessage(event)
    if (!interceptResult.allowed) {
      logger.info({ channelId, reason: interceptResult.reason }, '⏭️ 消息不进入引擎,交还 openclaw')
      return reply.code(200).send({ ok: true, eventId: null, reason: interceptResult.reason })
    }

    // ── 6. 进入 event inbox,触发新流程 ─────────────────────────────
    const eventId = createEvent({
      source: event.source,
      sourceEventId: event.sourceEventId,
      eventType: event.triggerType,
      payload: event
    })

    logger.info({ eventId, channelId, triggerType: event.triggerType }, '✅ Event received from OpenClaw')
    return reply.code(202).send({ ok: true, eventId })
  })

  // 手动触发(调试用)
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

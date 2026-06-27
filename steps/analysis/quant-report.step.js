'use strict'

const BaseStep = require('../base.step')
const { enqueueMessage } = require('../../persist/repos/outbox.repo')
const { outboxEmitter } = require('../../trigger/outbox-worker')
const logger = require('../../utils/logger')

/**
 * 量化报告推送步骤
 * 将报告内容发送到指定的 QQ 频道
 *
 * @workflow-config
 * - input: 报告内容（字符串）
 * - channelId: 目标 QQ 频道 ID（可选，默认从 event.context 获取）
 */
class QuantReportStep extends BaseStep {
  get name() { return 'quant-report' }
  get description() { return '将量化分析报告推送到 QQ 频道' }
  get category() { return 'output' }
  get requires() { return [] }
  get provides() { return ['sent'] }
  get retryable() { return true }
  get timeout() { return 10_000 }

  async execute(context, stepDef) {
    const report = context.get('report') || context.get('input') || ''
    const channelId = context.get('channelId') || context.get('event')?.channelId
    const runId = context.get('_runId')

    if (!report) {
      throw new Error('量化报告内容为空')
    }

    if (!channelId) {
      throw new Error('未指定目标 channelId')
    }

    // 将报告分段发送（QQ 消息有长度限制）
    const chunks = splitReport(report, 2000)

    for (const chunk of chunks) {
      const msgId = enqueueMessage({
        runId: runId || null,
        channelId,
        content: chunk,
      })
      outboxEmitter.emit('new_message', { msgId, runId: runId || null })
      logger.info({ msgId, channelId, length: chunk.length }, '📤 量化报告已入队')
    }

    return { ok: true, output: { sent: true, chunks: chunks.length } }
  }
}

/**
 * 将长文本按段落分割
 */
function splitReport(text, maxLen) {
  if (text.length <= maxLen) return [text]

  const chunks = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    // 在换行符处分割
    let splitIdx = remaining.lastIndexOf('\n', maxLen)
    if (splitIdx < maxLen * 0.5) {
      splitIdx = maxLen
    }

    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).trimStart()
  }

  return chunks
}

module.exports = QuantReportStep

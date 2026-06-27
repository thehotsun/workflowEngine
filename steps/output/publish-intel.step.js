'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')

/**
 * 推送金融信息 Step
 * 将高质量金融信息推送给用户
 */
class PublishIntelStep extends BaseStep {
  get name() { return 'publish-intel' }
  get description() { return '推送高质量金融信息' }
  get category() { return 'output' }
  get timeout() { return 15_000 }

  async execute(context, stepDef) {
    const digest = context.get('finalDigest') || {}
    const items = digest.items || []
    const analysis = context.get('financeAnalysis') || {}

    if (items.length === 0 && !analysis.overallSummary) {
      logger.info('📭 无高质量内容，跳过推送')
      return { ok: true, output: { pushed: 0 } }
    }

    // 格式化推送内容（包含分析报告）
    const message = this._formatMessage(items, analysis)

    logger.info({ count: items.length, messageLength: message.length }, '📤 推送金融信息')

    // 记录推送内容摘要
    const sources = {}
    for (const item of items) {
      const src = item.source || 'unknown'
      sources[src] = (sources[src] || 0) + 1
    }
    logger.info({
      itemCount: items.length,
      sources,
      sentiment: analysis.marketSentiment?.overall || 'N/A',
      signalCount: analysis.stockSignals?.length || 0,
      riskCount: analysis.risks?.length || 0,
    }, '📋 推送内容摘要')

    // 通过 OpenClaw message 工具推送
    try {
      // 从触发事件获取 channelId
      const event = context.get('event') || {}
      const channelId = event.channelId || context.get('channelId')

      if (channelId) {
        await openclawClient.sendMessage({
          channelId,
          content: message,
        })
        logger.info({ channelId }, '✅ 推送成功')
      } else {
        // 没有 channelId，输出到 context 供后续处理
        logger.info('ℹ️ 无 channelId，输出到 context')
        context.set('pushMessage', message)
      }

      return { ok: true, output: { pushed: items.length, message } }
    } catch (err) {
      logger.error({ err: err.message }, '❌ 推送失败')
      // 不阻断流程，推送失败不影响数据保存
      context.set('pushMessage', message)
      return { ok: true, output: { pushed: 0, error: err.message, message } }
    }
  }

  _formatMessage(items, analysis = {}) {
    const lines = ['📊 今日高质量金融信息', '']

    // 分析报告部分
    if (analysis.marketSentiment) {
      const s = analysis.marketSentiment
      lines.push(`📈 市场情绪：${s.overall}（信心 ${(s.confidence * 100).toFixed(0)}%）`)
      if (s.reason) lines.push(`   ${s.reason}`)
      lines.push('')
    }

    if (analysis.stockSignals?.length > 0) {
      lines.push('🎯 个股信号：')
      for (const sig of analysis.stockSignals.slice(0, 5)) {
        lines.push(`   ${sig.direction === '看多' ? '🟢' : '🔴'} ${sig.ticker} - ${sig.reason}`)
      }
      lines.push('')
    }

    if (analysis.risks?.length > 0) {
      lines.push('⚠️ 风险提示：')
      for (const risk of analysis.risks.slice(0, 3)) {
        lines.push(`   [${risk.severity}] ${risk.description}`)
      }
      lines.push('')
    }

    if (analysis.actionableInsights?.length > 0) {
      lines.push('💡 建议：')
      for (const insight of analysis.actionableInsights.slice(0, 3)) {
        lines.push(`   ${insight.action} ${insight.target} - ${insight.reason}`)
      }
      lines.push('')
    }

    if (analysis.overallSummary) {
      lines.push(`📝 综合摘要：${analysis.overallSummary}`)
      lines.push('')
    }

    // 高质量内容列表
    if (items.length > 0) {
      lines.push('━━━━━━━━━━━━━━')
      lines.push('')
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        lines.push(`${i + 1}. ${item.title}`)
        if (item.coreSummary) {
          lines.push(`   ${item.coreSummary}`)
        }
        lines.push(`   🔗 ${item.url}`)
        lines.push(`   📊 评分: ${item.score?.toFixed(1) || 'N/A'} | 来源: ${item.source || 'unknown'}`)
        lines.push('')
      }
    }

    return lines.join('\n')
  }
}

module.exports = PublishIntelStep

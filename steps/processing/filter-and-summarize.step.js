'use strict'

const BaseStep = require('../base.step')
const modelRouter = require('../../models/router')
const logger = require('../../utils/logger')

/**
 * 核心提炼 Step
 * 用 LLM 精炼每条高质量内容的核心信息
 */
class FilterAndSummarizeStep extends BaseStep {
  get name() { return 'filter-and-summarize' }
  get description() { return 'LLM 核心信息提炼：精炼高质量内容的要点' }
  get category() { return 'analysis' }
  get timeout() { return 90_000 }
  get requires() { return ['highQualityItems'] }
  get provides() { return ['finalDigest'] }

  async execute(context, stepDef) {
    const items = context.get('highQualityItems') || []

    if (items.length === 0) {
      logger.info('📭 没有高质量内容需要提炼')
      return { ok: true, output: { items: [], summary: '今日暂无高质量金融信息。' } }
    }

    logger.info({ count: items.length }, '📝 开始核心提炼')

    const flowConfig = context.get('_config') || {}
    const stepConfig = flowConfig[this._configKey] || {}
    const model = modelRouter.route(stepConfig.model?.taskType || 'analysis')

    // 记录输入内容来源分布
    const bySource = {}
    for (const item of items) {
      const src = item.source || 'unknown'
      bySource[src] = (bySource[src] || 0) + 1
    }
    logger.info({ count: items.length, bySource, topItems: items.slice(0, 3).map(i => ({ title: i.title?.slice(0, 40), score: i.score?.toFixed(1) })) }, '📋 提炼输入摘要')

    const summarized = []

    for (const item of items.slice(0, 20)) {
      try {
        const summary = await this._summarizeItem(model, item, stepConfig)
        summarized.push({
          ...item,
          coreSummary: summary,
        })
      } catch (err) {
        logger.warn({ title: item.title?.slice(0, 30), err: err.message }, '⚠️ 提炼失败')
        summarized.push({
          ...item,
          coreSummary: item.snippet || '',
        })
      }
    }

    const overallSummary = `📊 今日高质量金融信息 ${summarized.length} 条：\n\n` +
      summarized.map((item, i) =>
        `${i + 1}. [${item.score?.toFixed(1)}分] ${item.title}\n   ${item.coreSummary}`
      ).join('\n\n')

    logger.info({ count: summarized.length }, '✅ 核心提炼完成')
    return { ok: true, output: { items: summarized, summary: overallSummary } }
  }

  async _summarizeItem(model, item, config) {
    const content = `标题：${item.title}\n来源：${item.source}\n内容：${item.snippet || item.selftext || ''}`

    const messages = [
      {
        role: 'system',
        content: config.persona || '你是金融信息编辑。用3-5句话精炼一篇金融文章的核心信息，让读者30秒内抓住要点。**必须用中文输出，即使原文是英文也要翻译成中文。**',
      },
      {
        role: 'user',
        content: `请用3-5句话精炼以下金融文章的核心信息（必须用中文输出）：\n\n${content}`,
      },
    ]

    const result = await model.chat(messages, {
      temperature: config.temperature || 0.4,
      maxTokens: 500,
    })

    return result.content || item.snippet || ''
  }
}

module.exports = FilterAndSummarizeStep

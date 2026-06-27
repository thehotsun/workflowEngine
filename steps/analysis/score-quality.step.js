'use strict'

const BaseStep = require('../base.step')
const modelRouter = require('../../models/router')
const logger = require('../../utils/logger')

/**
 * 质量评分 Step
 * 使用 LLM 分析每条内容的质量，给出 0-10 分
 * 
 * 评分维度：
 * - 有具体数据/数字：+3
 * - 有引用来源：+2
 * - 逻辑链完整：+2
 * - 有可验证预测：+3
 * - 纯情绪喊单：-3
 */
class ScoreQualityStep extends BaseStep {
  get name() { return 'score-quality' }
  get description() { return 'LLM 质量评分：对采集内容进行深度质量评估' }
  get category() { return 'analysis' }
  get timeout() { return 120_000 }
  get requires() { return ['allRaw'] }
  get provides() { return ['scoredItems'] }

  async execute(context, stepDef) {
    const items = context.get('allRaw') || []
    const flowConfig = context.get('_config') || {}
    const stepConfig = flowConfig[this._configKey] || {}
    const threshold = flowConfig.quality?.threshold || 5.0

    if (items.length === 0) {
      logger.info('📭 无内容需要评分')
      return { ok: true, output: [] }
    }

    logger.info({ count: items.length }, '🔍 开始质量评分')

    const model = modelRouter.route(stepConfig.model?.taskType || 'analysis')
    const scoredItems = []

    // 批量评分（每批 5 条）
    const batchSize = 5
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)
      try {
        const scored = await this._scoreBatch(model, batch, stepConfig)
        scoredItems.push(...scored)
      } catch (err) {
        logger.warn({ batch: i, err: err.message }, '⚠️ 批次评分失败，降级为平台分')
        for (const item of batch) {
          scoredItems.push({
            ...item,
            score: this._calcPlatformScore(item),
            scoring: { method: 'fallback', reason: err.message },
          })
        }
      }
    }

    scoredItems.sort((a, b) => (b.score || 0) - (a.score || 0))

    const passed = scoredItems.filter(i => (i.score || 0) >= threshold).length
    const bySource = {}
    for (const item of scoredItems) {
      const src = item.source || 'unknown'
      if (!bySource[src]) bySource[src] = { total: 0, passed: 0 }
      bySource[src].total++
      if ((item.score || 0) >= threshold) bySource[src].passed++
    }
    logger.info({
      count: scoredItems.length,
      passed,
      topScore: scoredItems[0]?.score?.toFixed(1),
      avgScore: (scoredItems.reduce((s, i) => s + (i.score || 0), 0) / scoredItems.length).toFixed(1),
      bySource,
    }, '✅ 质量评分完成')

    return { ok: true, output: scoredItems }
  }

  async _scoreBatch(model, items, config) {
    const itemsText = items.map((item, idx) =>
      `[${idx}] 来源:${item.source} | 标题:${item.title || ''} | 内容:${(item.snippet || item.selftext || '').slice(0, 300)}`
    ).join('\n\n')

    const messages = [
      {
        role: 'system',
        content: config.persona || '你是严格的金融内容质量评估专家。只给真正有深度、有数据支撑的内容高分。情绪化喊单、没有论据的观点一律低分。',
      },
      {
        role: 'user',
        content: `请对以下 ${items.length} 条金融内容逐一评分（0-10分）。

评分标准：
- 有具体数据/数字：+3 分
- 有引用来源：+2 分
- 逻辑链完整：+2 分
- 有可验证预测：+3 分
- 纯情绪喊单/无数据：-3 分

内容列表：
${itemsText}

请严格返回 JSON 数组，每个元素格式：
{"idx": 0, "score": 7.5, "reason": "有具体估值数据和逻辑分析"}

只返回 JSON 数组，不要任何其他文字。`,
      },
    ]

    const result = await model.chat(messages, {
      temperature: config.temperature || 0.3,
      maxTokens: config.maxTokens || 1500,
    })

    const scores = this._parseScores(result.content, items.length)

    return items.map((item, idx) => {
      const platformScore = this._calcPlatformScore(item)
      const aiScore = scores[idx]?.score || 5
      // 加权：平台信号 30%，AI 内容分析 70%
      const weightedScore = platformScore * 0.3 + aiScore * 0.7

      return {
        ...item,
        score: Math.round(weightedScore * 10) / 10,
        scoring: {
          platform: platformScore,
          ai: aiScore,
          reason: scores[idx]?.reason || '',
          method: 'llm',
        },
      }
    })
  }

  _calcPlatformScore(item) {
    const score = item.score || 0
    const comments = item.num_comments || 0
    // 标准化到 0-10
    const raw = Math.log10(Math.max(score, 1)) * 2 + Math.log10(Math.max(comments, 1))
    return Math.min(Math.max(Math.round(raw * 10) / 10, 0), 10)
  }

  _parseScores(text, expectedCount) {
    try {
      const match = text.match(/\[[\s\S]*?\]/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed)) return parsed
      }
    } catch (e) {
      logger.warn({ text: text.slice(0, 200) }, '评分结果解析失败')
    }
    return Array.from({ length: expectedCount }, (_, i) => ({ idx: i, score: 5, reason: 'parse_failed' }))
  }
}

module.exports = ScoreQualityStep

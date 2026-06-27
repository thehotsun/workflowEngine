'use strict'

const BaseStep = require('../base.step')
const modelRouter = require('../../models/router')
const logger = require('../../utils/logger')

/**
 * 平台通用评分 Step 基类(10 问题分类制)
 *
 * 不再让 LLM 直接打分,而是回答 10 个是/否问题,
 * 根据"是"的数量计算最终分数。
 *
 * 优势:LLM 回答是/否比回答"几分"稳定得多
 */
class ScorePlatformBase extends BaseStep {
  get category() { return 'analysis' }
  get timeout() { return 120_000 }

  get platformKey() { throw new Error('Subclass must implement platformKey') }
  get platformLabel() { throw new Error('Subclass must implement platformLabel') }
  get evalLanguage() { return 'zh' }  // 'zh' 或 'en'，子类可覆盖

  // 评分 prompt
  get EVAL_QUESTIONS() {
    if (this.evalLanguage === 'en') {
      return this._EVAL_QUESTIONS_EN
    }
    return this._EVAL_QUESTIONS_ZH
  }

  get _EVAL_QUESTIONS_ZH() {
    return `请对以下金融内容逐一回答 10 个问题（回答“是”或“否”）：

一、数据层
1. 有没有具体数据？（股价/估值/营收/增长率等数字）
2. 有没有引用来源？（研报/公告/财报/新闻等出处）
3. 数据是否新鲜？（最近 3 个月内的数据）

二、逻辑层
4. 有没有逻辑推导？（不是直接给结论，有推理过程）
5. 有没有反面论证？（考虑了不同观点或风险）
6. 有没有风险提示？（不只是喊多，提到了潜在风险）

三、价值层
7. 结论是否可验证？（有明确的时间框架和判断指标）
8. 是否有可操作性？（具体买什么/什么时候/仓位建议）
9. 是否有独特视角？（不是重复市场共识，有独立思考）
10. 是否有行业/宏观背景？（不只是个股，有更广的分析）

注意：如果内容很短（只有标题或摘要），只要回答了问题就算“是”。例如：
- 有具体公司名/股票代码 → 问题1“是”
- 提到了来源（如“据XX报道”） → 问题2“是”
- 有观点/分析（不只是情绪） → 问题4“是”`
  }

  get _EVAL_QUESTIONS_EN() {
    return `For each piece of financial content below, answer 10 yes/no questions:

I. Data Layer
1. Does it contain specific data? (stock price/valuation/revenue/growth rate numbers)
2. Does it cite sources? (research reports/announcements/earnings/news)
3. Is the data recent? (within the last 3 months)

II. Logic Layer
4. Does it have logical reasoning? (not just conclusions, has推理过程)
5. Does it address counterarguments? (considers different观点 or risks)
6. Does it mention risks? (not just bullish, mentions potential risks)

III. Value Layer
7. Is the conclusion verifiable? (has clear time frame and判断指标)
8. Is it actionable? (specific what to buy/when/position size)
9. Does it have a unique perspective? (not repeating market consensus, has independent思考)
10. Does it have industry/macro context? (not just个股, has broader analysis)

Note: If content is short (only title or snippet), count a question as "yes" if it addresses the topic:
- Has specific company name/ticker → Q1 "yes"
- Mentions a source (e.g. "per XX report") → Q2 "yes"
- Has opinion/analysis (not just sentiment) → Q4 "yes"`
  }

  async execute(context, stepDef) {
    const platformData = context.get('platformData') || {}
    const items = platformData[this.platformKey] || []

    if (items.length === 0) {
      logger.info({ platform: this.platformLabel }, `📭 ${this.platformLabel} 无数据`)
      return { ok: true, output: [] }
    }

    logger.info({ platform: this.platformLabel, count: items.length }, `🔍 ${this.platformLabel} 开始评分`)

    const flowConfig = context.get('_config') || {}
    const stepConfig = { ...this._getDefaultConfig(), ...flowConfig[this._configKey] }

    try {
      const model = modelRouter.route(stepConfig.model?.taskType || 'analysis')
      const scored = await this._scoreItems(model, items, stepConfig)

      const avgScore = scored.reduce((s, i) => s + (i.score || 0), 0) / scored.length
      logger.info({
        platform: this.platformLabel,
        count: scored.length,
        avgScore: avgScore.toFixed(1),
      }, `✅ ${this.platformLabel} 评分完成`)

      return { ok: true, output: scored }
    } catch (err) {
      logger.error({ platform: this.platformLabel, err: err.message }, `❌ ${this.platformLabel} 评分失败,降级处理`)
      const fallback = items.map(item => ({
        ...item,
        score: this._calcPlatformScore(item),
        scoring: { method: 'fallback', reason: err.message },
      }))
      return { ok: true, output: fallback }
    }
  }

  async _scoreItems(model, items, config) {
    const batchSize = 3  // 每批 3 条,减少 token 用量
    const scored = []

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)
      try {
        const batchScored = await this._scoreBatch(model, batch, config)
        scored.push(...batchScored)
      } catch (err) {
        logger.warn({ batch: i, err: err.message }, `⚠️ 批次评分失败`)
        for (const item of batch) {
          scored.push({
            ...item,
            score: this._calcPlatformScore(item),
            scoring: { method: 'fallback', reason: err.message },
          })
        }
      }
    }

    return scored
  }

  async _scoreBatch(model, items, config) {
    const itemsText = items.map((item, idx) =>
      `[${idx}] 标题: ${item.title || ''}\n来源: ${item.source || ''}\n内容: ${(item.snippet || item.selftext || '').slice(0, 1000)}`
    ).join('\n\n---\n\n')

    const messages = [
      { role: 'system', content: '你是金融内容质量评估专家。请严格按照问题回答"是"或"否",不要解释。' },
      {
        role: 'user',
        content: `${this.EVAL_QUESTIONS}

内容列表:
${itemsText}

请严格返回 JSON 数组,每个元素格式:
{"idx": 0, "answers": [1,1,0,1,0,0,1,0,1,0], "reason": "一句话理由"}

answers 是 10 个数字(1=是,0=否),顺序对应 10 个问题。
只返回 JSON 数组,不要其他文字。`,
      },
    ]

    const result = await model.chat(messages, {
      temperature: 0.1,  // 低温度,确保一致性
      maxTokens: 2000,
    })

    const evaluations = this._parseEvaluations(result.content, items.length)

    return items.map((item, idx) => {
      const evalResult = evaluations[idx]
      const yesCount = (evalResult?.answers || []).filter(a => a === 1).length
      const score = this._yesCountToScore(yesCount)
      const platformScore = this._calcPlatformScore(item)

      // 综合分:平台信号 30% + LLM 评估 70%
      const finalScore = Math.round((platformScore * 0.3 + score * 0.7) * 10) / 10

      return {
        ...item,
        score: finalScore,
        scoring: {
          platform: platformScore,
          llm: score,
          yesCount,
          answers: evalResult?.answers || [],
          reason: evalResult?.reason || '',
          method: 'llm-10q',
        },
      }
    })
  }

  /**
   * 将"是"的数量转换为 0-10 分
   * ≥8 → 9, 6-7 → 7, 4-5 → 5, 2-3 → 3, 0-1 → 1
   */
  _yesCountToScore(yesCount) {
    if (yesCount >= 8) return 9
    if (yesCount >= 6) return 7
    if (yesCount >= 4) return 5
    if (yesCount >= 2) return 3
    return 1
  }

  _calcPlatformScore(item) {
    const score = item.score || 0
    const comments = item.num_comments || 0
    if (score === 0 && comments === 0) return 5  // 无数据时给默认分
    const raw = Math.log10(Math.max(score, 1)) * 2 + Math.log10(Math.max(comments, 1))
    return Math.min(Math.max(Math.round(raw * 10) / 10, 0), 10)
  }

  _parseEvaluations(text, expectedCount) {
    try {
      // 匹配包含 "idx" 的 JSON 数组(外层)
      const match = text.match(/\[[\s\S]*"idx"[\s\S]*\]/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed)) return parsed
      }
    } catch (e) {
      logger.warn({ text: text?.slice(0, 200) }, '评分结果解析失败')
    }
    // 降级:全部给默认答案
    return Array.from({ length: expectedCount }, (_, i) => ({
      idx: i,
      answers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      reason: 'parse_failed',
    }))
  }

  _getDefaultConfig() {
    return {
      model: { taskType: 'analysis' },
      temperature: 0.1,
      maxTokens: 2000,
    }
  }
}

module.exports = ScorePlatformBase

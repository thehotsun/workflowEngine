'use strict'

const BaseStep = require('../base.step')
const modelRouter = require('../../models/router')
const logger = require('../../utils/logger')

/**
 * 金融分析 Step
 * 对采集到的高质量内容进行专业金融分析
 *
 * 输入:高质量内容列表
 * 输出:结构化分析报告,包含:
 *   - 市场情绪判断
 *   - 热点主题识别
 *   - 个股信号提取
 *   - 风险提示
 *   - 可操作建议
 */
class AnalyzeFinanceStep extends BaseStep {
  get name() { return 'analyze-finance' }
  get description() { return '专业金融分析:市场情绪、热点主题、个股信号、风险提示' }
  get category() { return 'analysis' }
  get timeout() { return 120_000 }
  get requires() { return ['highQualityItems'] }
  get provides() { return ['financeAnalysis'] }

  async execute(context, stepDef) {
    const items = context.get('highQualityItems') || []

    if (items.length === 0) {
      logger.info('📭 无高质量内容需要分析')
      return { ok: true, output: { summary: '暂无足够数据进行分析。', signals: [], risks: [] } }
    }

    logger.info({ count: items.length }, '🔬 开始专业金融分析')

    const flowConfig = context.get('_config') || {}
    const stepConfig = { ...this._getDefaultConfig(), ...flowConfig[this._configKey] }

    try {
      const model = modelRouter.route(stepConfig.model?.taskType || 'analysis')

      // 构建分析输入
      const contentSummary = items.map((item, i) =>
        `[${i + 1}] ${item.source} | ${item.title}\n    ${(item.coreSummary || item.snippet || '').slice(0, 300)}`
      ).join('\n\n')

      const messages = [
        {
          role: 'system',
          content: stepConfig.persona || `你是资深金融分析师。你的分析风格：
- 数据驱动，不靠感觉
- 关注风险，不盲目乐观
- 给出可操作的建议
- 区分“事实”和“观点”
- 使用专业但易懂的语言
- **必须用中文输出，即使原文是英文也要翻译成中文**`,
        },
        {
          role: 'user',
          content: `请对以下 ${items.length} 条金融信息进行综合分析。

内容列表:
${contentSummary}

请按以下结构输出分析报告(JSON 格式):

{
  "marketSentiment": {
    "overall": "看多/看空/中性",
    "confidence": 0.7,
    "reason": "一句话理由"
  },
  "hotTopics": [
    {"topic": "主题名", "mentions": 3, "direction": "看多/看空/中性", "keyPoints": "要点"}
  ],
  "stockSignals": [
    {"ticker": "股票代码", "direction": "看多/看空", "source": "信息来源", "strength": "强/中/弱", "reason": "理由"}
  ],
  "risks": [
    {"type": "风险类型", "description": "描述", "severity": "高/中/低"}
  ],
  "actionableInsights": [
    {"action": "建议动作", "target": "标的", "reason": "理由", "urgency": "立即/近期/观察"}
  ],
  "overallSummary": "200字以内的综合分析摘要"
}

只返回 JSON,不要其他文字。`,
        },
      ]

      const result = await model.chat(messages, {
        temperature: stepConfig.temperature || 0.4,
        maxTokens: stepConfig.maxTokens || 3000,
      })

      const analysis = this._parseAnalysis(result.content)

      logger.info({
        sentiment: analysis.marketSentiment?.overall,
        hotTopics: analysis.hotTopics?.length || 0,
        stockSignals: analysis.stockSignals?.length || 0,
        risks: analysis.risks?.length || 0,
        insights: analysis.actionableInsights?.length || 0,
      }, '✅ 金融分析完成')

      return { ok: true, output: analysis }
    } catch (err) {
      logger.error({ err: err.message }, '❌ 金融分析失败')
      return {
        ok: true,
        output: {
          summary: `分析失败:${err.message}`,
          marketSentiment: { overall: '未知', confidence: 0, reason: '分析异常' },
          hotTopics: [],
          stockSignals: [],
          risks: [{ type: 'system', description: '分析模块异常', severity: '中' }],
          actionableInsights: [],
          overallSummary: '分析过程中出现错误,建议人工复核。',
          _error: err.message,
        },
      }
    }
  }

  _parseAnalysis(text) {
    try {
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        return JSON.parse(match[0])
      }
    } catch (e) {
      logger.warn({ text: text?.slice(0, 300) }, '分析结果解析失败')
    }

    // 降级:返回基础结构
    return {
      marketSentiment: { overall: '未知', confidence: 0, reason: '解析失败' },
      hotTopics: [],
      stockSignals: [],
      risks: [],
      actionableInsights: [],
      overallSummary: text?.slice(0, 500) || '分析结果解析失败',
      _parseError: true,
    }
  }

  _getDefaultConfig() {
    return {
      model: { taskType: 'analysis' },
      temperature: 0.4,
      maxTokens: 3000,
      persona: '你是资深金融分析师。数据驱动、关注风险、给出可操作建议。',
    }
  }
}

module.exports = AnalyzeFinanceStep

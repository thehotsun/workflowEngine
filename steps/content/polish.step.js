'use strict'

const BaseStep = require('../base.step')
const modelRouter = require('../../models/router')
const logger = require('../../utils/logger')

/**
 * polish step — 对已有文章进行润色优化
 * 
 * 主要功能：
 * - 保持文章原意
 * - 提升文字流畅度和可读性
 * - 优化段落结构
 * 
 * @workflow-config
 * - _config.polish.model.taskType: LLM 路由 taskType（默认 'writing'）
 * - _config.polish.temperature: LLM 温度（默认 0.5）
 * - _config.polish.maxTokens: 最大 token（默认 4000）
 * - _config.polish.persona: 编辑人设（string）
 * - _config.polish.styleGuide: 风格指南（object，含 focus/concrete/antiAI/rhythm/ending）
 * 
 * @requires ['article'] - 待润色的文章内容
 * @provides ['article'] - 润色后的文章
 */
class PolishStep extends BaseStep {
  get name() { return 'polish' }
  get description() { return '对已有文章进行润色：保持原意，提升可读性与段落结构（LLM）' }
  get category() { return 'content-creation' }
  get timeout() { return 300_000 }  // 5 分钟
  get requires() { return ['article'] }
  get provides() { return ['article'] }

  async execute(context) {
    const article = context.get('article')
    if (!article) throw new Error('polish: no article in context')

    logger.info({ wordCount: article.length }, '✨ polish: 开始润色')

    const config = context.get('_config') || {}
    const stepConfig = config[this._configKey] || {}

    const modelConfig = stepConfig.model || {}
    const taskType = modelConfig.taskType || 'writing'
    const modelOverride = modelConfig.model || null
    const temperature = stepConfig.temperature ?? 0.5
    const maxTokens = stepConfig.maxTokens ?? 4000

    const persona = stepConfig.persona || '你是一位专业编辑。'
    const styleGuide = stepConfig.styleGuide || {}

    const systemPrompt = stepConfig.systemPrompt || [
      persona,
      '请对以下文章进行润色：保持原意，提升文字流畅度和可读性，优化段落结构。',
      '',
      '硬性要求：',
      '1. 直接输出润色后的文章，不要输出任何编辑感言、修改说明、润色思路等额外内容。',
      '2. 不要在文章开头或结尾添加任何形式的总结、点评或互动引导。',
      '3. 结尾不要用金句式收尾（如"原来最深的爱…"），用场景自然收尾或留白。',
      '4. 人物名字、时间线、细节前后必须一致，不要产生矛盾。',
      '5. 不要出现"这篇文字本身已极富质感""像一盏温着的老茶"等编辑自我介绍式的内容。',
      '6. 润色后字数保持在 1200-1500 字之间，不要大幅删减原文的场景细节和对话。',
      styleGuide.focus ? `7. ${styleGuide.focus}` : '',
      styleGuide.concrete ? `8. ${styleGuide.concrete}` : '',
      styleGuide.antiAI ? `9. ${styleGuide.antiAI}` : '',
      styleGuide.rhythm ? `10. ${styleGuide.rhythm}` : '',
      styleGuide.ending ? `11. ${styleGuide.ending}` : ''
    ].filter(Boolean).join('\n')

    const model = modelRouter.route(taskType, { model: modelOverride })
    const { content, usage } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: article }
    ], { temperature, maxTokens })

    const chineseCount = (str) => (str.match(/[\u4e00-\u9fff]/g) || []).length
    logger.info({ wordCount: chineseCount(content) }, '✅ polish: 润色完成')

    return { ok: true, output: { article: content }, usage }
  }
}

module.exports = PolishStep

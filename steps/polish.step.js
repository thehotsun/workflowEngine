'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

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
  get timeout() { return 60_000 }
  get requires() { return ['article'] }
  get provides() { return ['article'] }

  async execute(context) {
    const article = context.get('article')
    if (!article) throw new Error('polish: no article in context')

    const config = context.get('_config') || {}
    const stepConfig = config[this._configKey] || {}

    const modelConfig = stepConfig.model || {}
    const taskType = modelConfig.taskType || 'writing'
    const temperature = stepConfig.temperature ?? 0.5
    const maxTokens = stepConfig.maxTokens ?? 4000

    const persona = stepConfig.persona || '你是一位专业编辑。'
    const styleGuide = stepConfig.styleGuide || {}

    const systemPrompt = stepConfig.systemPrompt || [
      persona,
      '请对以下文章进行润色：保持原意，提升文字流畅度和可读性，优化段落结构。',
      styleGuide.focus ? `重点：${styleGuide.focus}` : '',
      styleGuide.concrete ? `${styleGuide.concrete}` : '',
      styleGuide.antiAI ? `${styleGuide.antiAI}` : '',
      styleGuide.rhythm ? `${styleGuide.rhythm}` : '',
      styleGuide.ending ? `${styleGuide.ending}` : ''
    ].filter(Boolean).join('\n')

    const model = modelRouter.route(taskType)
    const { content, usage } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: article }
    ], { temperature, maxTokens })

    return { ok: true, output: { article: content }, usage }
  }
}

module.exports = PolishStep

'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

class PolishStep extends BaseStep {
  get name() { return 'polish' }
  get timeout() { return 60_000 }
  get requires() { return ['article'] }
  get provides() { return ['article'] }

  async execute(context) {
    const article = context.get('article')
    if (!article) throw new Error('polish: no article in context')

    const model = modelRouter.route('writing')
    const { content, usage } = await model.chat([
      { role: 'system', content: '你是一位专业编辑。请对以下文章进行润色：保持原意，提升文字流畅度和可读性，优化段落结构。' },
      { role: 'user', content: article }
    ])

    return { ok: true, output: { article: content }, usage }
  }
}

module.exports = PolishStep

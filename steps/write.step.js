'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

class WriteStep extends BaseStep {
  get name() { return 'write' }
  get timeout() { return 60_000 }
  get requires() { return ['topic'] }
  get provides() { return ['article'] }

  async execute(context, stepDef) {
    const topic = context.get('topic') || context.get('input')
    if (!topic) throw new Error('write: topic is required in context')
    const ragResults = context.get('ragResults', [])
    const searchResults = context.get('searchResults', [])

    const ragContext = ragResults.map(c => `${c.heading ? `[${c.heading}] ` : ''}${c.content}`).join('\n\n')
    const searchContext = Array.isArray(searchResults)
      ? searchResults.slice(0, 3).map(r => r.content || r.snippet || '').join('\n\n')
      : ''

    const systemPrompt = `你是一位专业的内容创作者。请根据以下背景资料，撰写一篇高质量的文章。`
    const userPrompt = [
      `主题：${topic}`,
      ragContext ? `\n知识库参考：\n${ragContext}` : '',
      searchContext ? `\n最新资讯参考：\n${searchContext}` : '',
      `\n请撰写一篇完整的文章，包含引言、正文（多个段落）和总结。`
    ].filter(Boolean).join('\n')

    const model = modelRouter.route('writing')
    const { content, usage } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ])

    return { ok: true, output: { article: content }, usage }
  }
}

module.exports = WriteStep

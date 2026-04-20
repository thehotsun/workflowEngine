'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

class TopicStep extends BaseStep {
  get name() { return 'topic' }
  get timeout() { return 20_000 }
  get requires() { return ['input'] }
  get provides() { return ['topic'] }

  async execute(context) {
    const input = context.get('input')
    if (!input) throw new Error('topic: input is required in context')
    const history = context.get('conversationHistory', [])
    const model = modelRouter.route('analysis')

    const messages = [
      { role: 'system', content: '你是一个内容选题助手，请从用户需求中提炼一个明确、适合写成长文的主题。只输出主题本身。' }
    ]

    // 注入多轮历史（最近 3 条）
    for (const h of history.slice(-3)) {
      if (h.userInput) messages.push({ role: 'user', content: h.userInput })
      if (h.topic) messages.push({ role: 'assistant', content: `上次主题：${h.topic}` })
    }

    messages.push({ role: 'user', content: input })

    const { content, usage } = await model.chat(messages)

    return { ok: true, output: { topic: content.trim() }, usage }
  }
}

module.exports = TopicStep

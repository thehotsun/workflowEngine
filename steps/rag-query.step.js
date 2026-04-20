'use strict'

const BaseStep = require('./base.step')
const retriever = require('../rag/retriever')

/**
 * 知识库检索 step
 * workflow 使用示例:
 * {
 *   type: 'rag-query',
 *   input: ctx => ({ query: ctx.get('topic') }),
 *   output: 'ragResults',
 *   topK: 5
 * }
 */
class RagQueryStep extends BaseStep {
  get name() { return 'rag-query' }
  get timeout() { return 20_000 }
  get requires() { return ['topic'] }
  get provides() { return ['ragResults'] }

  async execute(context, stepDef) {
    const inputData = typeof stepDef.input === 'function'
      ? stepDef.input(context)
      : { query: context.get('input') }

    const query = inputData.query
    if (!query) throw new Error('rag-query: query is required')

    const topK = stepDef.topK || 5
    const chunks = await retriever.retrieve({ query, topK })

    return { ok: true, output: chunks }
  }
}

module.exports = RagQueryStep

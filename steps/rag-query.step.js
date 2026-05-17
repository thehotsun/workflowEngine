'use strict'

const BaseStep = require('./base.step')
const retriever = require('../rag/retriever')

/**
 * 知识库检索 step
 * workflow 使用示例:
 * {
 *   type: 'rag-query',
 *   input: ctx => ({ query: ctx.get('topic') }),
 *   output: 'ragResults'
 * }
 *
 * @workflow-config
 * - _config.ragQuery.topK: 检索返回数量（默认 5）
 *
 * @requires [] - 无依赖（通过 stepDef.input 接收查询）
 * @provides ['ragResults'] - 知识库检索结果
 */
class RagQueryStep extends BaseStep {
  get name() { return 'rag-query' }
  get description() { return '对本地知识库进行向量检索，返回与 topic 相关的文档片段（向量召回 + BM25 重排）' }
  get category() { return 'retrieval' }
  get timeout() { return 20_000 }
  get requires() { return [] }
  get provides() { return ['ragResults'] }

  async execute(context, stepDef) {
    const inputData = typeof stepDef.input === 'function'
      ? stepDef.input(context)
      : { query: context.get('input') }

    const query = inputData.query
    if (!query) throw new Error('rag-query: query is required')

    const config = context.get('_config') || {}
    const stepConfig = config[this._configKey] || {}
    const topK = stepConfig.topK || 5
    const chunks = await retriever.retrieve({ query, topK })

    return { ok: true, output: chunks }
  }
}

module.exports = RagQueryStep

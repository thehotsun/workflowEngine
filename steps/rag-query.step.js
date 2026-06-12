'use strict'

const BaseStep = require('./base.step')
const retriever = require('../rag/retriever')
const logger = require('../utils/logger')

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
 * - _config.ragQuery.topK: 检索返回数量（默认 3）
 * - _config.ragQuery.minScore: 最低分数阈值（默认 0.3）
 * - _config.ragQuery.rerank: 是否 LLM 重排序（默认 true）
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
    const topK = stepConfig.topK || 3
    const minScore = stepConfig.minScore || 0.3
    const rerank = stepConfig.rerank !== false

    logger.info({ query: query.slice(0, 80), topK, minScore, rerank }, '🔍 rag-query: 开始检索')

    const chunks = await retriever.retrieve({ query, topK, minScore, rerank })

    logger.info({
      hitCount: chunks.length,
      topHeading: chunks[0]?.heading || null,
      topScore: chunks[0]?.score || null,
      scores: chunks.map(c => ({ heading: c.heading?.slice(0, 20), score: c.score })),
    }, '✅ rag-query: 检索完成')

    return { ok: true, output: chunks }
  }
}

module.exports = RagQueryStep

'use strict'

const embedder = require('./embedder')
const { isVectorAvailable } = require('../persist/db')
const { vectorSearch, textSearch, getChunksByIds, getActiveChunkCount, getDocumentFrequencyByTerms } = require('./store')
const modelRouter = require('../models/router')
const logger = require('../utils/logger')

/**
 * 检索知识库
 * 优先路径：embedding → 向量召回 → BM25 重排
 * 降级路径：sqlite-vec 不可用 或 embedding 失败 → 纯文本 LIKE 检索
 *
 * @param {object} opts
 * @param {string} opts.query - 查询文本
 * @param {number} [opts.topK=3] - 返回数量
 * @param {number} [opts.minScore=0.3] - 最低分数阈值，低于此值的结果会被过滤
 * @returns {Array<{id, heading, content, score}>}
 */
async function retrieve({ query, topK = 3, minScore = 0.3, rerank = true }) {
  // 显式检测 sqlite-vec 是否可用，不可用则直接走文本降级，避免建表失败引发异常
  if (!isVectorAvailable()) {
    logger.warn('RAG: sqlite-vec not available, using text search fallback')
    return textSearch(query, topK)
  }

  let useVec = true
  let queryVec

  try {
    queryVec = await embedder.embedding(query)
  } catch (err) {
    logger.warn({ err: err.message }, 'RAG: embedding failed, falling back to text search')
    useVec = false
  }

  if (useVec) {
    const candidates = vectorSearch(queryVec, topK * 4)

    if (!candidates.length) {
      logger.info('RAG: vector search returned 0 results, falling back to text search')
      return textSearch(query, topK)
    }

    const chunkIds = candidates.map(c => c.chunkId)
    const chunks = getChunksByIds(chunkIds)
    if (!chunks.length) return textSearch(query, topK)

    const scoreMap = {}
    for (const c of candidates) scoreMap[c.chunkId] = c.score

    const keywords = tokenize(query)

    // 获取 BM25 所需的 IDF 统计数据（N 和每个关键词的 df）
    const N = getActiveChunkCount()
    const dfMap = getDocumentFrequencyByTerms(keywords)

    // BM25 的平均文档长度按分词后的词项数量计算
    const avgLen = chunks.reduce((sum, c) => sum + tokenize(c.content || '').length, 0) / (chunks.length || 1)

    const reranked = chunks.map(chunk => {
      const vecScore = scoreMap[chunk.id] || 0
      const bm25 = bm25Score(chunk.content, keywords, { k1: 1.5, b: 0.75, avgLen, N, dfMap })
      return {
        ...chunk,
        vecScore,
        bm25Score: bm25,
        finalScore: vecScore * 0.7 + bm25 * 0.3
      }
    })

    reranked.sort((a, b) => b.finalScore - a.finalScore)

    // 阈值过滤：去掉低质量结果
    let filtered = reranked.filter(c => c.finalScore >= minScore)

    // LLM Rerank：用 LLM 对结果进行二次排序
    if (rerank && filtered.length > 1) {
      try {
        filtered = await llmRerank(query, filtered)
        logger.info({ count: filtered.length }, 'RAG: LLM Rerank 完成')
      } catch (err) {
        logger.warn({ err: err.message }, 'RAG: LLM Rerank 失败，使用原始排序')
      }
    }

    // 返回时附带 score 字段
    return filtered.slice(0, topK).map(c => ({
      id: c.id,
      doc_id: c.doc_id,
      chunk_index: c.chunk_index,
      heading: c.heading,
      content: c.content,
      score: Math.round((c.rerankScore || c.finalScore) * 1000) / 1000,
      vecScore: Math.round(c.vecScore * 1000) / 1000,
      bm25Score: Math.round(c.bm25Score * 1000) / 1000,
      rerankScore: c.rerankScore ? Math.round(c.rerankScore * 1000) / 1000 : null,
    }))
  }

  return textSearch(query, topK)
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * 标准 BM25 评分（Robertson & Sparck Jones）
 * IDF = log((N - df + 0.5) / (df + 0.5) + 1)  — 标准 Lucene/Elasticsearch 公式，值域 ≥ 0
 * TF-norm = freq * (k1 + 1) / (freq + k1 * (1 - b + b * docLen / avgLen))
 *
 * @param {string} text - 文档内容
 * @param {string[]} keywords - 查询词列表
 * @param {object} opts - { k1, b, avgLen, N, dfMap }
 * @returns {number}
 */
function bm25Score(text, keywords, { k1 = 1.5, b = 0.75, avgLen = 500, N = 1, dfMap = {} } = {}) {
  const terms = tokenize(text)
  const docLen = terms.length || 1
  const safeAvgLen = avgLen || 1
  const tf = {}
  for (const t of terms) tf[t] = (tf[t] || 0) + 1

  let score = 0
  for (const kw of keywords) {
    const freq = tf[kw] || 0
    if (!freq) continue

    const df = dfMap[kw] || 0
    // 标准 Okapi BM25 IDF，确保非负
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)
    const numerator = freq * (k1 + 1)
    const denominator = freq + k1 * (1 - b + b * docLen / safeAvgLen)
    score += idf * (numerator / denominator)
  }
  return score
}

/**
 * LLM Rerank：用 LLM 对检索结果进行相关性排序
 * @param {string} query - 查询文本
 * @param {Array} chunks - 检索结果列表
 * @returns {Array} 重排序后的结果
 */
async function llmRerank(query, chunks) {
  if (chunks.length <= 1) return chunks

  // 构建 chunk 摘要列表
  const chunkSummaries = chunks.map((c, i) => {
    const preview = (c.content || '').slice(0, 100).replace(/\n/g, ' ')
    return `[${i}] ${c.heading || ''}: ${preview}`
  }).join('\n')

  const model = modelRouter.route('analysis')
  const { content } = await model.chat([
    {
      role: 'system',
      content: '你是一个文档相关性评估助手。根据查询和文档片段的相关性，输出排序后的索引列表。\n要求：\n1. 只输出相关文档的索引号，用逗号分隔\n2. 相关的排前面，不相关的排后面或不输出\n3. 最多输出 5 个索引号\n4. 只输出索引列表，不要解释'
    },
    {
      role: 'user',
      content: `查询：${query}\n\n文档片段：\n${chunkSummaries}`
    }
  ], { temperature: 0.1, maxTokens: 100 })

  // 解析 LLM 返回的索引列表
  const indices = content.match(/\d+/g)?.map(Number) || []
  const validIndices = indices.filter(i => i >= 0 && i < chunks.length)

  if (!validIndices.length) return chunks

  // 按 LLM 排序重新排列，未被选中的放最后
  const selected = validIndices.map(i => chunks[i]).filter(Boolean)
  const unselected = chunks.filter((_, i) => !validIndices.includes(i))

  // 为 reranked 结果添加 rerankScore
  return [...selected, ...unselected].map((c, i) => ({
    ...c,
    rerankScore: c.finalScore * (1 + (selected.length - i) * 0.1)
  }))
}

module.exports = { retrieve }

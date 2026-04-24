'use strict'

const embedder = require('./embedder')
const { isVectorAvailable } = require('../persist/db')
const { vectorSearch, textSearch, getChunksByIds, getActiveChunkCount, getDocumentFrequencyByTerms } = require('./store')
const logger = require('../utils/logger')

/**
 * 检索知识库
 * 优先路径：embedding → 向量召回 → BM25 重排
 * 降级路径：sqlite-vec 不可用 或 embedding 失败 → 纯文本 LIKE 检索
 */
async function retrieve({ query, topK = 5 }) {
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
    return reranked.slice(0, topK)
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

module.exports = { retrieve }

'use strict'

const { getDb } = require('../persist/db')

/**
 * 向量相似度搜索
 * @param {number[]} queryVector - query 向量
 * @param {number} topK - 召回数量
 * @returns {Array<{chunkId, score}>}
 */
function vectorSearch(queryVector, topK = 20) {
  const db = getDb()
  try {
    const rows = db.prepare(`
      SELECT kv.chunk_id,
             vec_distance_cosine(kv.embedding, ?) AS distance
      FROM knowledge_vectors kv
      ORDER BY distance ASC
      LIMIT ?
    `).all(JSON.stringify(queryVector), topK)

    return rows.map(row => ({
      chunkId: row.chunk_id,
      score: 1 - row.distance
    }))
  } catch (err) {
    const message = err.message || ''
    if (
      message.includes('no such table') ||
      message.includes('no such function') ||
      message.includes('unknown function') ||
      message.includes('SQLITE_ERROR')
    ) {
      return []
    }
    throw err
  }
}

/**
 * 文本检索降级：无 sqlite-vec 时，对 knowledge_chunks 做关键词 LIKE 匹配
 * 直接返回带 heading/content 的 chunk 对象（与 getChunksByIds 结构一致）
 * @param {string} query
 * @param {number} topK
 * @returns {Array}
 */
function textSearch(query, topK = 10) {
  const db = getDb()
  const keywords = tokenize(query)
  if (!keywords.length) return []

  const conditions = keywords.map(() => 'kc.content LIKE ?').join(' OR ')
  const params = keywords.map(k => `%${k}%`)

  const rows = db.prepare(`
    SELECT kc.id, kc.doc_id, kc.chunk_index, kc.heading, kc.content, kc.token_count,
           kd.file_path, kd.title AS doc_title
    FROM knowledge_chunks kc
    JOIN knowledge_docs kd ON kd.id = kc.doc_id
    WHERE kd.status = 'active' AND (${conditions})
    LIMIT 200
  `).all(...params)

  return rows
    .map(row => ({
      ...row,
      vecScore: 0,
      bm25Score: keywordScore(row.content, keywords),
      finalScore: keywordScore(row.content, keywords)
    }))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, topK)
}

function getChunksByIds(chunkIds = []) {
  if (!chunkIds.length) return []
  const db = getDb()
  const placeholders = chunkIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT kc.id, kc.doc_id, kc.chunk_index, kc.heading, kc.content, kc.token_count,
           kd.file_path, kd.title AS doc_title
    FROM knowledge_chunks kc
    JOIN knowledge_docs kd ON kd.id = kc.doc_id
    WHERE kc.id IN (${placeholders}) AND kd.status = 'active'
  `).all(...chunkIds)
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function keywordScore(text, keywords) {
  const lower = text.toLowerCase()
  let score = 0
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matches = lower.match(new RegExp(escaped, 'g'))
    score += matches ? matches.length : 0
  }
  return score
}

function getActiveChunkCount() {
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(1) AS total
    FROM knowledge_chunks kc
    JOIN knowledge_docs kd ON kd.id = kc.doc_id
    WHERE kd.status = 'active'
  `).get()
  return row?.total || 0
}

function getDocumentFrequencyByTerms(terms = []) {
  const db = getDb()
  const uniqueTerms = Array.from(new Set((terms || []).filter(Boolean)))
  const result = {}

  for (const term of uniqueTerms) {
    const row = db.prepare(`
      SELECT COUNT(1) AS df
      FROM knowledge_chunks kc
      JOIN knowledge_docs kd ON kd.id = kc.doc_id
      WHERE kd.status = 'active' AND instr(lower(kc.content), lower(?)) > 0
    `).get(term)
    result[term] = row?.df || 0
  }

  return result
}

module.exports = { vectorSearch, textSearch, getChunksByIds, getActiveChunkCount, getDocumentFrequencyByTerms }

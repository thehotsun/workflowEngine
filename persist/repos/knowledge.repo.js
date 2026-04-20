'use strict'

const { getDb } = require('../db')
const { v4: uuidv4 } = require('uuid')

function upsertDoc({ filePath, fileHash, title, chunkCount = 0 }) {
  const db = getDb()
  const now = Date.now()
  const existing = db.prepare(`SELECT * FROM knowledge_docs WHERE file_path = ?`).get(filePath)

  if (existing) {
    db.prepare(`
      UPDATE knowledge_docs
      SET file_hash = ?, title = ?, status = 'active', chunk_count = ?, indexed_at = ?, updated_at = ?
      WHERE file_path = ?
    `).run(fileHash, title || existing.title, chunkCount, now, now, filePath)
    return db.prepare(`SELECT * FROM knowledge_docs WHERE file_path = ?`).get(filePath)
  }

  const id = `doc_${uuidv4().replace(/-/g, '')}`
  db.prepare(`
    INSERT INTO knowledge_docs (id, file_path, file_hash, title, status, chunk_count, indexed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(id, filePath, fileHash, title || null, chunkCount, now, now, now)

  return db.prepare(`SELECT * FROM knowledge_docs WHERE id = ?`).get(id)
}

function getDocByPath(filePath) {
  return getDb().prepare(`SELECT * FROM knowledge_docs WHERE file_path = ?`).get(filePath)
}

function listActiveDocs() {
  return getDb().prepare(`SELECT * FROM knowledge_docs WHERE status = 'active'`).all()
}

function deleteDocChunks(docId) {
  const db = getDb()
  const chunkIds = db.prepare(`SELECT id FROM knowledge_chunks WHERE doc_id = ?`).all(docId).map(row => row.id)
  if (chunkIds.length) {
    const placeholders = chunkIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM knowledge_vectors WHERE chunk_id IN (${placeholders})`).run(...chunkIds)
  }
  db.prepare(`DELETE FROM knowledge_chunks WHERE doc_id = ?`).run(docId)
}

function insertChunks(docId, chunks = []) {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO knowledge_chunks (id, doc_id, chunk_index, heading, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const now = Date.now()
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run(row.id, docId, row.chunkIndex, row.heading || null, row.content, row.tokenCount || null, now)
    }
  })
  tx(chunks)
}

function insertVectors(vectors = []) {
  const db = getDb()
  const stmt = db.prepare(`INSERT INTO knowledge_vectors (chunk_id, embedding) VALUES (?, ?)`)
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run(row.chunkId, JSON.stringify(row.embedding))
    }
  })
  tx(vectors)
}

function markDeleted(filePath) {
  getDb().prepare(`UPDATE knowledge_docs SET status = 'deleted', updated_at = ? WHERE file_path = ?`).run(Date.now(), filePath)
}

module.exports = {
  upsertDoc,
  getDocByPath,
  listActiveDocs,
  deleteDocChunks,
  insertChunks,
  insertVectors,
  markDeleted
}

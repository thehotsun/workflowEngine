'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { KNOWLEDGE_DIR, EMBEDDING_DIMENSION } = require('../config')
const { chunkMarkdown } = require('./chunker')
const embedder = require('./embedder')
const {
  upsertDoc,
  getDocByPath,
  listActiveDocs,
  deleteDocChunks,
  insertChunks,
  insertVectors,
  getDocIndexStats,
  getVectorDimension,
  cleanupOrphanVectors,
  markDeleted
} = require('../persist/repos/knowledge.repo')

const VECTOR_DIMENSION = EMBEDDING_DIMENSION

async function ingestKnowledge(dir = KNOWLEDGE_DIR) {
  assertVectorDimension()
  const orphanCount = cleanupOrphanVectors()
  if (orphanCount) console.warn(`[ingest] cleaned ${orphanCount} orphan vectors`)

  const files = walkMarkdownFiles(dir)
  const seen = new Set()

  for (const filePath of files) {
    seen.add(filePath)
    const raw = fs.readFileSync(filePath, 'utf8')
    const hash = sha256(raw)
    const existing = getDocByPath(filePath)

    if (existing && existing.file_hash === hash) {
      const stats = getDocIndexStats(existing.id)
      if (stats.chunkCount === existing.chunk_count && stats.vectorCount === existing.chunk_count) {
        continue // 无变化且索引完整，跳过
      }
      console.warn(`[ingest] ${path.basename(filePath)} index incomplete, rebuilding (${stats.chunkCount} chunks, ${stats.vectorCount} vectors, expected ${existing.chunk_count})`)
    }

    const title = extractTitle(raw) || path.basename(filePath, '.md')
    const chunks = chunkMarkdown(raw)
    const doc = upsertDoc({ filePath, fileHash: hash, title, chunkCount: chunks.length })

    // 如果是更新，先删旧数据
    deleteDocChunks(doc.id)

    const chunkRows = chunks.map((chunk, idx) => ({
      id: `chunk_${uuidv4().replace(/-/g, '')}`,
      chunkIndex: idx,
      heading: chunk.heading,
      content: chunk.content,
      tokenCount: chunk.tokenCount
    }))

    insertChunks(doc.id, chunkRows)

    try {
      const vectors = await embedder.embeddings(chunkRows.map(c => c.content))
      if (vectors.length !== chunkRows.length) {
        throw new Error(`embedding count mismatch: got ${vectors.length}, expected ${chunkRows.length}`)
      }
      for (const [i, vector] of vectors.entries()) {
        if (!Array.isArray(vector) || vector.length !== VECTOR_DIMENSION) {
          throw new Error(`embedding dimension mismatch at chunk ${i}: got ${Array.isArray(vector) ? vector.length : 'invalid'}, expected ${VECTOR_DIMENSION}`)
        }
      }
      insertVectors(chunkRows.map((chunk, i) => ({
        chunkId: chunk.id,
        embedding: vectors[i]
      })))
    } catch (err) {
      deleteDocChunks(doc.id)
      console.error(`[ingest] ${path.basename(filePath)} index failed, cleaned partial chunks/vectors:`, err.message)
      throw err
    }

    console.log(`[ingest] ${path.basename(filePath)} done (${chunkRows.length} chunks)`)
  }

  // 处理被删除的文件
  const activeDocs = listActiveDocs()
  for (const doc of activeDocs) {
    if (!seen.has(doc.file_path)) {
      deleteDocChunks(doc.id)
      markDeleted(doc.file_path)
    }
  }
}

function assertVectorDimension() {
  const dbDimension = getVectorDimension()
  if (dbDimension && dbDimension !== VECTOR_DIMENSION) {
    throw new Error(`knowledge_vectors dimension mismatch: database float[${dbDimension}], config EMBEDDING_DIMENSION=${VECTOR_DIMENSION}. Recreate knowledge_vectors or fix EMBEDDING_DIMENSION.`)
  }
}

function walkMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const result = []

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(fullPath)
    }
  }

  walk(dir)
  return result
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

if (require.main === module) {
  ingestKnowledge().then(() => {
    console.log('Knowledge ingest completed')
  }).catch(err => {
    console.error('Knowledge ingest failed:', err)
    process.exit(1)
  })
}

module.exports = { ingestKnowledge }

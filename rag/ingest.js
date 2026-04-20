'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { KNOWLEDGE_DIR } = require('../config')
const { chunkMarkdown } = require('./chunker')
const embedder = require('./embedder')
const {
  upsertDoc,
  getDocByPath,
  listActiveDocs,
  deleteDocChunks,
  insertChunks,
  insertVectors,
  markDeleted
} = require('../persist/repos/knowledge.repo')

async function ingestKnowledge(dir = KNOWLEDGE_DIR) {
  const files = walkMarkdownFiles(dir)
  const seen = new Set()

  for (const filePath of files) {
    seen.add(filePath)
    const raw = fs.readFileSync(filePath, 'utf8')
    const hash = sha256(raw)
    const existing = getDocByPath(filePath)

    if (existing && existing.file_hash === hash) {
      continue // 无变化，跳过
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

    const vectors = await embedder.embeddings(chunkRows.map(c => c.content))
    insertVectors(chunkRows.map((chunk, i) => ({
      chunkId: chunk.id,
      embedding: vectors[i]
    })))
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

'use strict'

const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { DB_PATH } = require('../config')

let _db = null
let _vecAvailable = false

function getDb() {
  if (_db) return _db

  const dbDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

  _db = new Database(DB_PATH)

  // 性能与稳定性配置
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous = NORMAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('busy_timeout = 5000')
  _db.pragma('cache_size = -32000')  // 32MB 缓存

  // 加载 sqlite-vec 扩展（向量搜索）
  try {
    require('sqlite-vec').load(_db)
    _vecAvailable = true
  } catch (e) {
    _vecAvailable = false
    console.warn('[db] sqlite-vec extension not loaded, RAG will fall back to text search:', e.message)
  }

  // 执行 schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  _db.exec(schema)

  return _db
}

function closeDb() {
  if (_db) {
    _db.close()
    _db = null
  }
}

function isVectorAvailable() {
  // 确保初始化后返回真实状态
  if (!_db) getDb()
  return _vecAvailable
}

module.exports = { getDb, closeDb, isVectorAvailable }

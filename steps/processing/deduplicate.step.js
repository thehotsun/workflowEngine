'use strict'

const fs = require('fs')
const path = require('path')
const logger = require('../../utils/logger')

/**
 * 去重存储 Step
 * 记录已处理的 URL，过滤重复内容
 * 
 * 存储文件：data/seen-urls.json
 * 格式：{ "url": timestamp }
 * 自动清理 30 天前的记录
 */
class DeduplicateStep {
  get name() { return 'deduplicate' }
  get description() { return 'URL 去重：过滤已推送过的重复内容' }
  get category() { return 'processing' }
  get timeout() { return 5000 }

  constructor() {
    this._storagePath = path.join(process.cwd(), 'data', 'seen-urls.json')
    this._cache = null
    this._ensureDir()
  }

  _ensureDir() {
    const dir = path.dirname(this._storagePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  _load() {
    if (this._cache) return this._cache
    try {
      if (fs.existsSync(this._storagePath)) {
        const data = JSON.parse(fs.readFileSync(this._storagePath, 'utf8'))
        this._cache = data
      } else {
        this._cache = {}
      }
    } catch (e) {
      this._cache = {}
    }
    return this._cache
  }

  _save() {
    try {
      fs.writeFileSync(this._storagePath, JSON.stringify(this._cache, null, 2))
    } catch (e) {
      logger.warn({ err: e.message }, '⚠️ 去重存储写入失败')
    }
  }

  /**
   * 清理 30 天前的记录
   */
  _cleanup() {
    const seen = this._load()
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    let cleaned = 0
    for (const [url, ts] of Object.entries(seen)) {
      if (ts < cutoff) {
        delete seen[url]
        cleaned++
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, '🧹 清理过期去重记录')
      this._save()
    }
  }

  async execute(context, stepDef) {
    const items = context.get('allScored') || []
    const seen = this._load()

    // 每次运行清理过期记录
    this._cleanup()

    const unique = []
    let duplicates = 0

    for (const item of items) {
      const key = item.url || item.title
      if (!key) continue

      if (seen[key]) {
        duplicates++
        continue
      }

      seen[key] = Date.now()
      unique.push(item)
    }

    this._save()

    logger.info({
      total: items.length,
      unique: unique.length,
      duplicates,
    }, `🔍 去重完成：${unique.length}/${items.length} 条新内容`)

    return { ok: true, output: unique }
  }
}

module.exports = DeduplicateStep

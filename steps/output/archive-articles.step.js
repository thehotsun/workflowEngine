'use strict'

const fs = require('fs')
const path = require('path')
const logger = require('../../utils/logger')

/**
 * 文章存档 Step
 * 将推送过的文章存入数据库，供后续分析和对比
 * 
 * 存储：data/article-archive.json
 * 结构：{ articles: [...], stats: {...} }
 */
class ArchiveArticlesStep {
  get name() { return 'archive-articles' }
  get description() { return '存档推送过的文章到数据库' }
  get category() { return 'output' }
  get timeout() { return 5000 }

  constructor() {
    this._storagePath = path.join(process.cwd(), 'data', 'article-archive.json')
    this._ensureDir()
  }

  _ensureDir() {
    const dir = path.dirname(this._storagePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  _load() {
    try {
      if (fs.existsSync(this._storagePath)) {
        return JSON.parse(fs.readFileSync(this._storagePath, 'utf8'))
      }
    } catch (e) {
      logger.warn({ err: e.message }, '⚠️ 存档读取失败')
    }
    return { articles: [], stats: { totalPushed: 0, bySource: {} } }
  }

  _save(data) {
    try {
      fs.writeFileSync(this._storagePath, JSON.stringify(data, null, 2))
    } catch (e) {
      logger.warn({ err: e.message }, '⚠️ 存档写入失败')
    }
  }

  async execute(context, stepDef) {
    const digest = context.get('finalDigest') || {}
    const analysis = context.get('financeAnalysis') || {}
    const items = digest.items || []

    if (items.length === 0) {
      logger.info('📭 无文章需要存档')
      return { ok: true, output: { archived: 0 } }
    }

    const db = this._load()
    const now = new Date().toISOString()

    for (const item of items) {
      db.articles.push({
        title: item.title || '',
        url: item.url || '',
        source: item.source || '',
        score: item.score || 0,
        summary: item.coreSummary || item.snippet || '',
        pushedAt: now,
        analysis: {
          sentiment: analysis.marketSentiment?.overall || '',
          signals: (analysis.stockSignals || [])
            .filter(s => item.title?.includes(s.ticker) || item.snippet?.includes(s.ticker))
            .map(s => s.ticker),
        },
      })

      // 更新统计
      const src = item.source || 'unknown'
      db.stats.bySource[src] = (db.stats.bySource[src] || 0) + 1
      db.stats.totalPushed++
    }

    // 保留最近 1000 条
    if (db.articles.length > 1000) {
      db.articles = db.articles.slice(-1000)
    }

    this._save(db)

    logger.info({
      archived: items.length,
      totalInDB: db.articles.length,
    }, `💾 存档完成：${items.length} 条文章已保存`)

    return { ok: true, output: { archived: items.length, totalInDB: db.articles.length } }
  }
}

module.exports = ArchiveArticlesStep

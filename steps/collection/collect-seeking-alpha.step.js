'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')
const { extractSearchResults } = require('../../utils/search-results')

/**
 * Seeking Alpha 采集 Step
 * 通过 Tavily 搜索 Seeking Alpha 上的专业个股分析
 */
class CollectSeekingAlphaStep extends BaseStep {
  get name() { return 'collect-seeking-alpha' }
  get description() { return '从 Seeking Alpha 采集专业个股分析文章' }
  get category() { return 'collection' }
  get timeout() { return 60_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('_config') || {}
    const config = { ...this._getDefaultConfig(), ...flowConfig.seekingAlpha }

    logger.info({ queries: config.queries.length }, '📡 Seeking Alpha: 开始采集')

    const allArticles = []

    for (const query of config.queries) {
      try {
        const startMs = Date.now()
        const result = await openclawClient.invokeTool('web_search', {
          query: `site:seekingalpha.com ${query}`,
          count: config.count || 5,
          freshness: config.freshness || "week",
        }, { timeoutMs: 15000 })
        const latencyMs = Date.now() - startMs

        const results = extractSearchResults(result)
        let matched = 0
        for (const item of results) {
          if (item.url && item.url.includes('seekingalpha.com')) {
            matched++
            allArticles.push({
              title: item.title || '',
              url: item.url,
              snippet: (item.snippet || '').slice(0, 500),
              source: 'seekingalpha',
              sourceDetail: 'seekingalpha',
            })
          }
        }
        logger.info({ query: query.slice(0, 50), returned: results.length, matched, latencyMs, sample: allArticles.slice(0, 3) }, '📝 Seeking Alpha 搜索结果详情')
      } catch (err) {
        logger.warn({ query: query.slice(0, 50), err: err.message }, '❌ Seeking Alpha 搜索失败')
      }
    }

    // 去重
    const seen = new Set()
    const unique = allArticles.filter(p => {
      if (!p.url || seen.has(p.url)) return false
      seen.add(p.url)
      return true
    })

    logger.info({ total: allArticles.length, unique: unique.length }, '✅ Seeking Alpha 采集完成')
    return { ok: true, output: unique }
  }

  _getDefaultConfig() {
    return {
      queries: [
        'stock analysis undervalued',
        'earnings analysis buy sell',
        'investment thesis 2026',
      ],
      count: 5,
    }
  }
}

module.exports = CollectSeekingAlphaStep

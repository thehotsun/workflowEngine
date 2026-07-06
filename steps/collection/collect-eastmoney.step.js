'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')
const { extractSearchResults } = require('../../utils/search-results')

/**
 * 东方财富采集 Step
 * 通过 Tavily 搜索东方财富上的 A 股深度分析和研报
 */
class CollectEastmoneyStep extends BaseStep {
  get name() { return 'collect-eastmoney' }
  get description() { return '从东方财富采集 A 股深度分析和研报' }
  get category() { return 'collection' }
  get timeout() { return 60_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('_config') || {}
    const config = { ...this._getDefaultConfig(), ...flowConfig.eastmoney }

    logger.info({ queries: config.queries.length }, '📡 东方财富: 开始采集')

    const allArticles = []

    for (const query of config.queries) {
      try {
        const startMs = Date.now()
        const result = await openclawClient.invokeTool('web_search', {
          query: `site:eastmoney.com ${query}`,
          count: config.count || 5,
          freshness: config.freshness || "week",
        }, { timeoutMs: 15000 })
        const latencyMs = Date.now() - startMs

        const results = extractSearchResults(result)
        let matched = 0
        for (const item of results) {
          if (item.url && item.url.includes('eastmoney.com')) {
            matched++
            allArticles.push({
              title: item.title || '',
              url: item.url,
              snippet: (item.snippet || '').slice(0, 500),
              source: 'eastmoney',
              sourceDetail: 'eastmoney',
            })
          }
        }
        logger.info({ query: query.slice(0, 50), returned: results.length, matched, latencyMs, sample: allArticles.slice(0, 3) }, '📝 东方财富搜索结果详情')
      } catch (err) {
        logger.warn({ query: query.slice(0, 50), err: err.message }, '❌ 东方财富搜索失败')
      }
    }

    const seen = new Set()
    const unique = allArticles.filter(p => {
      if (!p.url || seen.has(p.url)) return false
      seen.add(p.url)
      return true
    })

    logger.info({ total: allArticles.length, unique: unique.length }, '✅ 东方财富采集完成')
    return { ok: true, output: unique }
  }

  _getDefaultConfig() {
    return {
      queries: [
        '深度分析 个股 研报',
        'A股 市场分析 展望',
        '价值投资 低估 股票',
      ],
      count: 5,
    }
  }
}

module.exports = CollectEastmoneyStep

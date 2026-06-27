'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')
const { extractSearchResults } = require('../../utils/search-results')

/**
 * 同花顺采集 Step
 * 通过 Tavily 搜索同花顺上的行业研报和分析
 */
class CollectTonghuashunStep extends BaseStep {
  get name() { return 'collect-tonghuashun' }
  get description() { return '从同花顺采集行业研报和分析' }
  get category() { return 'collection' }
  get timeout() { return 60_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('_config') || {}
    const config = { ...this._getDefaultConfig(), ...flowConfig.tonghuashun }

    logger.info({ queries: config.queries.length }, '📡 同花顺: 开始采集')

    const allArticles = []

    for (const query of config.queries) {
      try {
        const startMs = Date.now()
        const result = await openclawClient.invokeTool('web_search', {
          query: `site:10jqka.com.cn ${query}`,
          count: config.count || 5,
          freshness: config.freshness || 'week',
        }, { timeoutMs: 15000 })
        const latencyMs = Date.now() - startMs

        const results = extractSearchResults(result)
        let matched = 0
        for (const item of results) {
          if (item.url && item.url.includes('10jqka.com.cn')) {
            matched++
            allArticles.push({
              title: item.title || '',
              url: item.url,
              snippet: (item.snippet || '').slice(0, 500),
              source: 'tonghuashun',
              sourceDetail: 'tonghuashun',
            })
          }
        }
        logger.info({ query: query.slice(0, 50), returned: results.length, matched, latencyMs }, '📊 同花顺搜索结果')
      } catch (err) {
        logger.warn({ query: query.slice(0, 50), err: err.message }, '❌ 同花顺搜索失败')
      }
    }

    const seen = new Set()
    const unique = allArticles.filter(p => {
      if (!p.url || seen.has(p.url)) return false
      seen.add(p.url)
      return true
    })

    logger.info({ total: allArticles.length, unique: unique.length }, '✅ 同花顺采集完成')
    return { ok: true, output: unique }
  }

  _getDefaultConfig() {
    return {
      queries: [
        '行业分析 研报 2026',
        'A股 行业景气度 投资机会',
        '券商 策略 观点',
      ],
      count: 5,
      freshness: 'week',
    }
  }
}

module.exports = CollectTonghuashunStep

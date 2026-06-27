'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')
const { extractSearchResults } = require('../../utils/search-results')

/**
 * 雪球采集 Step
 * 通过 Tavily 搜索雪球上的 A 股深度分析
 */
class CollectXueqiuStep extends BaseStep {
  get name() { return 'collect-xueqiu' }
  get description() { return '从雪球采集 A 股深度分析和投资策略' }
  get category() { return 'collection' }
  get timeout() { return 60_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('_config') || {}
    const config = { ...this._getDefaultConfig(), ...flowConfig.xueqiu }

    logger.info({ queries: config.queries.length }, '📡 雪球: 开始采集')

    const allArticles = []

    for (const query of config.queries) {
      try {
        const startMs = Date.now()
        const result = await openclawClient.invokeTool('web_search', {
          query: `site:xueqiu.com ${query}`,
          count: config.count || 5,
          freshness: config.freshness || 'week',
        }, { timeoutMs: 15000 })
        const latencyMs = Date.now() - startMs

        const results = extractSearchResults(result)
        let matched = 0
        for (const item of results) {
          if (item.url && item.url.includes('xueqiu.com')) {
            matched++
            allArticles.push({
              title: item.title || '',
              url: item.url,
              snippet: (item.snippet || '').slice(0, 500),
              source: 'xueqiu',
              sourceDetail: 'xueqiu',
            })
          }
        }
        logger.info({ query: query.slice(0, 50), returned: results.length, matched, latencyMs }, '📊 雪球搜索结果')
      } catch (err) {
        logger.warn({ query: query.slice(0, 50), err: err.message }, '❌ 雪球搜索失败')
      }
    }

    const seen = new Set()
    const unique = allArticles.filter(p => {
      if (!p.url || seen.has(p.url)) return false
      seen.add(p.url)
      return true
    })

    logger.info({ total: allArticles.length, unique: unique.length }, '✅ 雪球采集完成')
    return { ok: true, output: unique }
  }

  _getDefaultConfig() {
    return {
      queries: [
        'A股 深度分析 投资策略',
        '行业分析 估值 低估',
        '个股分析 基本面 研报',
      ],
      count: 5,
      freshness: 'week',
    }
  }
}

module.exports = CollectXueqiuStep

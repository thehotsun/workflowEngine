'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')
const { extractSearchResults } = require('../../utils/search-results')

/**
 * Substack 采集 Step
 * 通过 Tavily 搜索 Substack 上的金融 Newsletter
 */
class CollectSubstackStep extends BaseStep {
  get name() { return 'collect-substack' }
  get description() { return '从 Substack 采集金融 Newsletter 深度分析' }
  get category() { return 'collection' }
  get timeout() { return 60_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('_config') || {}
    const config = { ...this._getDefaultConfig(), ...flowConfig.substack }

    logger.info({ queries: config.queries.length }, '📡 Substack: 开始采集')

    const allArticles = []

    for (const query of config.queries) {
      try {
        const startMs = Date.now()
        const result = await openclawClient.invokeTool('web_search', {
          query: `site:substack.com ${query}`,
          count: config.count || 5,
          freshness: config.freshness || "week",
        }, { timeoutMs: 15000 })
        const latencyMs = Date.now() - startMs

        const results = extractSearchResults(result)
        let matched = 0
        for (const item of results) {
          if (item.url && item.url.includes('substack.com')) {
            matched++
            allArticles.push({
              title: item.title || '',
              url: item.url,
              snippet: (item.snippet || '').slice(0, 500),
              source: 'substack',
              sourceDetail: 'substack',
            })
          }
        }
        logger.info({ query: query.slice(0, 50), returned: results.length, matched, latencyMs, sample: allArticles.slice(0, 3) }, '📝 Substack 搜索结果详情')
      } catch (err) {
        logger.warn({ query: query.slice(0, 50), err: err.message }, '❌ Substack 搜索失败')
      }
    }

    const seen = new Set()
    const unique = allArticles.filter(p => {
      if (!p.url || seen.has(p.url)) return false
      seen.add(p.url)
      return true
    })

    logger.info({ total: allArticles.length, unique: unique.length }, '✅ Substack 采集完成')
    return { ok: true, output: unique }
  }

  _getDefaultConfig() {
    return {
      queries: [
        'market outlook stock analysis',
        'investment portfolio strategy',
        'earnings report analysis',
      ],
      count: 5,
    }
  }
}

module.exports = CollectSubstackStep

'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')
const { extractSearchResults } = require('../../utils/search-results')

/**
 * X/Twitter 采集 Step
 * 通过 Tavily 搜索 X/Twitter 上的金融内容
 */
class CollectTwitterStep extends BaseStep {
  get name() { return 'collect-twitter' }
  get description() { return '从 X/Twitter 采集金融内容' }
  get category() { return 'collection' }
  get timeout() { return 45_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('config') || {}
    const twitterConfig = { ...this.getDefaultConfig(), ...flowConfig.twitter }

    logger.info({ queries: twitterConfig.queries.length }, '📡 开始 X/Twitter 采集')

    const allPosts = []

    for (const query of twitterConfig.queries) {
      try {
        const startMs = Date.now()
        const result = await openclawClient.invokeTool('web_search', {
          query,
          count: twitterConfig.count || 5,
        }, { timeoutMs: 15000 })
        const latencyMs = Date.now() - startMs

        const results = extractSearchResults(result)
        for (const item of results) {
          allPosts.push({
            title: item.title || '',
            url: item.url || '',
            snippet: item.snippet || '',
            source: 'twitter',
          })
        }
        logger.info({ query: query.slice(0, 50), returned: results.length, latencyMs }, '📊 X/Twitter 搜索结果')
      } catch (err) {
        logger.warn({ query: query.slice(0, 50), err: err.message }, '❌ X/Twitter 搜索失败')
      }
    }

    // 去重
    const seen = new Set()
    const unique = allPosts.filter(p => {
      if (!p.url || seen.has(p.url)) return false
      seen.add(p.url)
      return true
    })

    logger.info({ total: allPosts.length, unique: unique.length }, '✅ X/Twitter 采集完成')
    return { ok: true, output: unique }
  }

  getDefaultConfig() {
    return {
      queries: [
        'stock market analysis twitter',
        'investment thesis twitter',
        'A股 market analysis twitter',
      ],
      count: 5,
      freshness: 'week',
    }
  }
}

module.exports = CollectTwitterStep

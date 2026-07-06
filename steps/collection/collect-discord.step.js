'use strict'

const BaseStep = require('../base.step')
const openclawClient = require('../../openclaw/client')
const logger = require('../../utils/logger')

/**
 * Discord 采集 Step
 * 通过 AnswerOverflow 搜索 Discord 社区讨论
 */
class CollectDiscordStep extends BaseStep {
  get name() { return 'collect-discord' }
  get description() { return '从 Discord 采集金融社区讨论' }
  get category() { return 'collection' }
  get timeout() { return 45_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('config') || {}
    const discordConfig = { ...this.getDefaultConfig(), ...flowConfig.discord }

    logger.info({ queries: discordConfig.queries.length }, '📡 开始 Discord 采集')

    const allPosts = []

    for (const query of discordConfig.queries) {
      try {
        const startMs = Date.now()
        // 通过 Tavily 搜索 Discord 内容
        const result = await openclawClient.invokeTool('web_search', {
          query: `${query} site:discord.com OR site:answeroverflow.com`,
          count: 5,
        }, { timeoutMs: 15000 })
        const latencyMs = Date.now() - startMs

        const results = result?.results || []
        for (const item of results) {
          allPosts.push({
            title: item.title || '',
            url: item.url || '',
            snippet: item.snippet || '',
            source: 'discord',
          })
        }
        logger.info({ query: query.slice(0, 50), returned: results.length, latencyMs, sample: results.slice(0, 3) }, '📝 Discord 搜索结果详情')
      } catch (err) {
        logger.warn({ query: query.slice(0, 50), err: err.message }, '❌ Discord 搜索失败')
      }
    }

    logger.info({ total: allPosts.length }, '✅ Discord 采集完成')
    return { ok: true, output: allPosts }
  }

  getDefaultConfig() {
    return {
      queries: ['stock analysis', 'value investing', 'earnings report'],
    }
  }
}

module.exports = CollectDiscordStep

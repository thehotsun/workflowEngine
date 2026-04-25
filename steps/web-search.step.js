'use strict'

const BaseStep = require('./base.step')
const openclawClient = require('../openclaw/client')
const logger = require('../utils/logger')

/**
 * 网页搜索步骤
 * 调用 OpenClaw 的 web-search 能力（通过 web 工具的 search action）
 *
 * workflow 中使用示例:
 * {
 *   type: 'web-search',
 *   query: ctx => ctx.get('topic'),
 *   output: 'searchResults',
 *   count: 5,
 *   timeout: 20000
 * }
 */
class WebSearchStep extends BaseStep {
  get name() { return 'web-search' }
  get description() { return '调用 OpenClaw web-search 搜索最新资讯' }
  get category() { return 'integration' }
  get timeout() { return 20_000 }

  async execute(context, stepDef) {
    const query = typeof stepDef.query === 'function'
      ? stepDef.query(context)
      : (stepDef.query || context.get('topic') || context.get('input'))

    if (!query) {
      throw new Error('web-search requires a query')
    }

    const count = stepDef.count || 5
    const freshness = stepDef.freshness  // 'day' | 'week' | 'month' | 'year'

    logger.info({ query, count, freshness }, '🔍 开始网页搜索')

    const startedAt = Date.now()

    try {
      const result = await openclawClient.invokeTool('web', {
        query,
        count,
        ...(freshness ? { freshness } : {})
      }, {
        action: 'search',
        timeoutMs: stepDef.timeout || this.timeout
      })

      const durationMs = Date.now() - startedAt

      // 解析搜索结果
      const searchResults = this.parseSearchResults(result)

      logger.info({
        query,
        resultsCount: searchResults.length,
        durationMs
      }, '✅ 网页搜索完成')

      return {
        ok: true,
        output: searchResults,
        metadata: {
          query,
          count,
          freshness,
          durationMs,
          rawResult: result
        }
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      logger.error({ query, durationMs, err: err.message }, '❌ 网页搜索失败')
      throw err
    }
  }

  /**
   * 解析搜索结果，统一格式
   */
  parseSearchResults(result) {
    if (!result) return []

    // 处理不同的返回格式
    if (Array.isArray(result)) {
      return result.map(item => this.normalizeResult(item))
    }

    if (result.results && Array.isArray(result.results)) {
      return result.results.map(item => this.normalizeResult(item))
    }

    if (result.web_results && Array.isArray(result.web_results)) {
      return result.web_results.map(item => this.normalizeResult(item))
    }

    // 如果是单个对象，包装成数组
    if (result.title || result.url || result.snippet) {
      return [this.normalizeResult(result)]
    }

    return []
  }

  /**
   * 标准化单个搜索结果
   */
  normalizeResult(item) {
    return {
      title: item.title || item.name || '无标题',
      url: item.url || item.link || '',
      snippet: item.snippet || item.description || item.summary || '',
      source: item.source || item.site_name || '',
      publishedAt: item.published_date || item.date || '',
      raw: item
    }
  }
}

module.exports = WebSearchStep

'use strict'

const http = require('http')
const BaseStep = require('../base.step')
const https = require('https')
const logger = require('../../utils/logger')

/**
 * fetch-hotspots step - 抓取热点（微博、头条、百度、抖音、B站）
 *
 * @workflow-config
 * - _config.fetchHotspots.limitPerSource: 每个来源抓取数量（默认 100）
 * - _config.fetchHotspots.enabledSources: 启用的来源（默认 ['toutiao', 'baidu', 'douyin']）
 *
 * @requires [] - 无依赖
 * @provides ['hotspots'] - 热点列表
 */
class FetchHotspotsStep extends BaseStep {
  get name() { return 'fetch-hotspots' }
  get description() { return '实时抓取微博/头条/百度/抖音/B站热搜，输出标准化热点列表（真实 API，失败自动降级为样本数据）' }
  get category() { return 'data-fetch' }
  get timeout() { return 30000 }
  get retryable() { return true }
  get requires() { return [] }
  get provides() { return ['hotspots'] }

  _sampleHotspots = [
    {
      title: '多地提醒春季气温反复，慢病老人注意保暖和作息',
      hotness: 9800,
      source: 'sample',
      url: '',
    },
    {
      title: '退休人员关注异地就医结算和医保报销流程',
      hotness: 9300,
      source: 'sample',
      url: '',
    },
    {
      title: '老年人常见电信诈骗套路再升级，社区连续发提醒',
      hotness: 9100,
      source: 'sample',
      url: '',
    },
    {
      title: '清明后家庭踏青升温，老人出行安全和用药话题受关注',
      hotness: 8700,
      source: 'sample',
      url: '',
    },
    {
      title: '夜里总醒、白天没精神，春季睡眠问题成高频讨论',
      hotness: 8600,
      source: 'sample',
      url: '',
    },
  ]

  _deduplicate(items) {
    const seen = new Set()
    const result = []
    for (const item of items) {
      const key = (item.title || '').trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      result.push(item)
    }
    return result
  }

  _requestJson(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const protocol = parsedUrl.protocol === 'http:' ? http : https
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }

      if (parsedUrl.hostname === 'weibo.com') {
        options.headers['Referer'] = 'https://weibo.com/'
        options.headers['Accept'] = 'application/json, text/plain, */*'
      }

      const req = protocol.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          logger.info({ url, status: res.statusCode, headers: res.headers }, '🌐 HTTP 响应')
          try {
            resolve(JSON.parse(data))
          } catch (err) {
            reject(new Error(`JSON 解析失败：${err.message}`))
          }
        })
      })

      req.on('error', (err) => {
        reject(new Error(`请求失败：${err.message}`))
      })

      req.setTimeout(15000, () => {
        req.destroy()
        reject(new Error('请求超时'))
      })

      req.end()
    })
  }

  async _fetchWithRetry(url, tries = 3) {
    const backoff = [1000, 2000, 4000]
    const startMs = Date.now()
    let lastError = null

    for (let i = 0; i < tries; i++) {
      try {
        const result = await this._requestJson(url)
        const latencyMs = Date.now() - startMs
        logger.info({ url, tries: i + 1, latencyMs }, '🔄 请求成功')
        return result
      } catch (err) {
        lastError = err
        if (i < tries - 1) {
          await new Promise(r => setTimeout(r, backoff[i]))
        }
      }
    }

    const latencyMs = Date.now() - startMs
    logger.info({ url, tries, latencyMs }, '🔄 请求重试完成')
    throw new Error(`热点接口请求失败：${lastError}`)
  }

  async _fetchWeibo(limit) {
    try {
      const data = await this._fetchWithRetry('https://weibo.com/ajax/side/hotSearch')
      const realtime = data?.data?.realtime || []
      if (!Array.isArray(realtime)) return []

      logger.info({ rawCount: realtime.length }, '📥 微博原始数据')
      const items = []
      for (const item of realtime.slice(0, limit)) {
        const word = String(item.word || '').trim()
        if (!word) continue
        items.push({
          title: word,
          hotness: Number(item.num || 0),
          source: 'weibo',
          url: `https://s.weibo.com/weibo?q=${encodeURIComponent(word)}`
        })
      }
      logger.info({ source: 'weibo', kept: items.length, sample: items.slice(0, 3) }, '📝 微博热点样本')
      return items
    } catch (err) {
      logger.warn({ source: 'weibo', err: err.message }, '❌ 微博抓取失败')
      return []
    }
  }

  async _fetchToutiao(limit) {
    try {
      const data = await this._fetchWithRetry('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc')
      const board = data?.data || []
      if (!Array.isArray(board)) return []

      logger.info({ rawCount: board.length }, '📥 头条原始数据')
      const items = []
      for (const item of board.slice(0, limit)) {
        const title = String(item.Title || '').trim()
        if (!title) continue
        items.push({
          title,
          hotness: Number(item.HotValue || 0),
          source: 'toutiao',
          url: String(item.Url || '').trim()
        })
      }
      logger.info({ source: 'toutiao', kept: items.length, sample: items.slice(0, 3) }, '📝 头条热点样本')
      return items
    } catch (err) {
      logger.warn({ source: 'toutiao', err: err.message }, '❌ 头条抓取失败')
      return []
    }
  }

  async _fetchBaidu(limit) {
    try {
      const data = await this._fetchWithRetry('https://top.baidu.com/api/board?platform=wise&tab=realtime')
      const cards = data?.data?.cards || []
      if (!Array.isArray(cards) || cards.length === 0) return []

      logger.info({ rawCount: cards.length }, '📥 百度原始数据')
      const content = cards[0]?.content || []
      if (!Array.isArray(content)) return []

      const items = []
      for (const item of content.slice(0, limit)) {
        const title = String(item.word || '').trim()
        if (!title) continue
        items.push({
          title,
          hotness: Number(item.hotScore || 0),
          source: 'baidu',
          url: String(item.url || '').trim()
        })
      }
      logger.info({ source: 'baidu', kept: items.length, sample: items.slice(0, 3) }, '📝 百度热点样本')
      return items
    } catch (err) {
      logger.warn({ source: 'baidu', err: err.message }, '❌ 百度抓取失败')
      return []
    }
  }

  async _fetchDouyin(limit) {
    try {
      const data = await this._fetchWithRetry('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/')
      const wordList = data?.word_list || []
      if (!Array.isArray(wordList)) return []

      logger.info({ rawCount: wordList.length }, '📥 抖音原始数据')
      const items = []
      for (const item of wordList.slice(0, limit)) {
        const title = String(item.word || '').trim()
        if (!title) continue
        items.push({
          title,
          hotness: Number(item.hot_value || 0),
          source: 'douyin',
          url: ''
        })
      }
      logger.info({ source: 'douyin', kept: items.length, sample: items.slice(0, 3) }, '📝 抖音热点样本')
      return items
    } catch (err) {
      logger.warn({ source: 'douyin', err: err.message }, '❌ 抖音抓取失败')
      return []
    }
  }

  async _fetchBilibili(limit) {
    try {
      const data = await this._fetchWithRetry('https://api.bilibili.com/x/web-interface/search/square?limit=' + limit)
      const trending = data?.data?.trending?.list || []
      if (!Array.isArray(trending)) return []

      logger.info({ rawCount: trending.length }, '📥 B 站原始数据')
      const items = []
      for (const item of trending.slice(0, limit)) {
        const title = String(item.keyword || '').trim()
        if (!title) continue
        items.push({
          title,
          hotness: Number(item.hot_id || 0),
          source: 'bilibili',
          url: ''
        })
      }
      logger.info({ source: 'bilibili', kept: items.length, sample: items.slice(0, 3) }, '📝 B 站热点样本')
      return items
    } catch (err) {
      logger.warn({ source: 'bilibili', err: err.message }, '❌ B 站抓取失败')
      return []
    }
  }

  async execute(context, stepDef) {
    const config = context.get('_config')?.fetchHotspots || {}
    const limit = config.limitPerSource || 100
    const enabledSources = config.enabledSources || ['toutiao', 'baidu', 'douyin']
    const demo = config.demo || false

    logger.info({ sources: enabledSources, limit, demo }, '📰 fetch-hotspots: 开始抓取热点')

    if (demo) {
      const hotspots = {
        timestamp: new Date().toISOString(),
        demo: true,
        fallbackUsed: true,
        sources: ['sample'],
        items: this._sampleHotspots.slice(0, limit),
      }
      return {
        ok: true,
        output: { hotspots },
      }
    }

    let fallbackUsed = false

    // 并行抓取所有来源，单个失败不影响其他
    const fetchMap = {
      toutiao: this._fetchToutiao,
      baidu: this._fetchBaidu,
      douyin: this._fetchDouyin,
    }

    const results = await Promise.allSettled(
      enabledSources.map(source => {
        const fn = fetchMap[source]
        return fn ? fn.call(this, limit) : Promise.resolve([])
      })
    )

    let items = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const source = enabledSources[i]
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        logger.info({ source, count: result.value.length }, `📊 ${source} 热点获取成功`)
        items.push(...result.value)
      } else {
        logger.warn({ source, reason: result.reason?.message || 'unknown' }, `❌ ${source} 热点获取失败`)
      }
    }

    items = this._deduplicate(items)
    items.sort((a, b) => (b.hotness || 0) - (a.hotness || 0))

    if (items.length === 0) {
      fallbackUsed = true
      items = this._sampleHotspots.slice(0, limit)
    }

    const hotspots = {
      timestamp: new Date().toISOString(),
      demo: false,
      fallbackUsed,
      sources: [...new Set(items.map(i => i.source))].sort(),
      items,
    }

    logger.info({ itemCount: items.length, fallbackUsed, sources: hotspots.sources }, '✅ fetch-hotspots: 抓取完成')

    return {
      ok: true,
      output: { hotspots },
    }
  }
}

module.exports = FetchHotspotsStep

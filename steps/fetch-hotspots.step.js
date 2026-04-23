'use strict'

const BaseStep = require('./base.step')
const https = require('https')

/**
 * fetch-hotspots step - 抓取热点（微博、头条、百度）
 *
 * @workflow-config
 * - _config.hotspots.limitPerSource: 每个来源抓取数量（默认10）
 * - _config.hotspots.enabledSources: 启用的来源（默认 ['weibo', 'toutiao', 'baidu']）
 */
class FetchHotspotsStep extends BaseStep {
  get name() { return 'fetch-hotspots' }
  get description() { return '实时抓取微博/头条/百度热搜，输出标准化热点列表（真实 API，失败自动降级为样本数据）' }
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
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
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
    let lastError = null

    for (let i = 0; i < tries; i++) {
      try {
        return await this._requestJson(url)
      } catch (err) {
        lastError = err
        if (i < tries - 1) {
          await new Promise(r => setTimeout(r, backoff[i]))
        }
      }
    }

    throw new Error(`热点接口请求失败：${lastError}`)
  }

  async _fetchWeibo(limit) {
    try {
      const data = await this._fetchWithRetry('https://weibo.com/ajax/side/hotSearch')
      const realtime = data?.data?.realtime || []
      if (!Array.isArray(realtime)) return []

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
      return items
    } catch {
      return []
    }
  }

  async _fetchToutiao(limit) {
    try {
      const data = await this._fetchWithRetry('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc')
      const board = data?.data || []
      if (!Array.isArray(board)) return []

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
      return items
    } catch {
      return []
    }
  }

  async _fetchBaidu(limit) {
    try {
      const data = await this._fetchWithRetry('https://top.baidu.com/api/board?platform=wise&tab=realtime')
      const cards = data?.data?.cards || []
      if (!Array.isArray(cards) || cards.length === 0) return []

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
      return items
    } catch {
      return []
    }
  }

  async execute(context, stepDef) {
    const config = context.get('_config')?.hotspots || {}
    const limit = config.limitPerSource || 10
    const enabledSources = config.enabledSources || ['weibo', 'toutiao', 'baidu']
    const demo = config.demo || false

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

    let items = []
    let fallbackUsed = false

    for (const source of enabledSources) {
      try {
        if (source === 'weibo') {
          items.push(...(await this._fetchWeibo(limit)))
        } else if (source === 'toutiao') {
          items.push(...(await this._fetchToutiao(limit)))
        } else if (source === 'baidu') {
          items.push(...(await this._fetchBaidu(limit)))
        }
      } catch {
        // 单个来源失败不影响其他来源
        continue
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

    return {
      ok: true,
      output: { hotspots },
    }
  }
}

module.exports = FetchHotspotsStep

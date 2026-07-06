'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')

/**
 * Arctic Shift Reddit 采集 Step
 * 通过 Arctic Shift API 获取完整 Reddit 帖子数据
 * 包含：全文、分数、评论数、upvote_ratio、作者、flair 等
 */
class CollectRedditArcticStep extends BaseStep {
  get name() { return 'collect-reddit-arctic' }
  get description() { return '通过 Arctic Shift 获取完整 Reddit 帖子数据（全文+互动数据）' }
  get category() { return 'collection' }
  get timeout() { return 90_000 }

  async execute(context, stepDef) {
    const flowConfig = context.get('_config') || {}
    const config = { ...this._getDefaultConfig(), ...flowConfig.reddit }

    logger.info({ subreddits: config.subreddits }, '📡 Arctic Shift: 开始 Reddit 采集')

    const allPosts = []

    for (const subreddit of config.subreddits) {
      try {
        const posts = await this._fetchSubreddit(subreddit, config)
        allPosts.push(...posts)
        logger.info({ subreddit, sample: posts.slice(0, 3) }, `📝 r/${subreddit} 数据样本`)
        logger.info({ subreddit, count: posts.length }, `✅ r/${subreddit} 采集完成`)
      } catch (err) {
        logger.warn({ subreddit, err: err.message }, `⚠️ r/${subreddit} 采集失败`)
      }
    }

    // 去重
    const seen = new Set()
    const unique = allPosts.filter(p => {
      if (!p.url || seen.has(p.url)) return false
      seen.add(p.url)
      return true
    })

    logger.info({ total: allPosts.length, unique: unique.length }, '✅ Arctic Shift Reddit 采集完成')
    return { ok: true, output: unique }
  }

  async _fetchSubreddit(subreddit, config) {
    const url = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${subreddit}&limit=${config.limitPerSub || 20}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    const startMs = Date.now()

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'WorkflowEngine/1.0' },
      })
      clearTimeout(timer)
      const latencyMs = Date.now() - startMs

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        logger.warn({ subreddit, url, status: res.status, latencyMs, body: body.slice(0, 200) }, '❌ Arctic Shift HTTP 错误')
        throw new Error(`HTTP ${res.status}`)
      }

      const data = await res.json()
      const rawCount = (data.data || []).length
      const posts = (data.data || []).filter(p => {
        const text = p.selftext || ''
        return text !== '[removed]' && text !== '[deleted]' && text !== ''
      })
      const filtered = rawCount - posts.length

      logger.info({ subreddit, url, status: res.status, latencyMs, rawCount, filtered, kept: posts.length }, '📊 Arctic Shift 响应')

      return posts.map(p => ({
        title: p.title || '',
        author: p.author || '',
        score: p.score || 0,
        num_comments: p.num_comments || 0,
        upvote_ratio: p.upvote_ratio || 0,
        url: `https://reddit.com${p.permalink || ''}`,
        subreddit: p.subreddit || subreddit,
        selftext: (p.selftext || '').slice(0, 2000),
        created_utc: p.created_utc || 0,
        flair: p.link_flair_text || '',
        source: 'reddit',
        sourceDetail: 'arctic-shift',
      }))
    } catch (err) {
      clearTimeout(timer)
      const latencyMs = Date.now() - startMs
      if (err.name === 'AbortError') {
        logger.warn({ subreddit, url, latencyMs }, '❌ Arctic Shift 请求超时')
      } else {
        logger.warn({ subreddit, url, latencyMs, err: err.message }, '❌ Arctic Shift 请求失败')
      }
      throw err
    }
  }

  _getDefaultConfig() {
    return {
      subreddits: ['ValueInvesting', 'investing', 'stocks', 'wallstreetbets'],
      limitPerSub: 20,
    }
  }
}

module.exports = CollectRedditArcticStep

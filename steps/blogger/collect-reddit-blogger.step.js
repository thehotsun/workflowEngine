'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')
const fs = require('fs')
const path = require('path')

/**
 * Reddit 博主数据采集 Step
 * 输入 Reddit 用户名，采集该用户的帖子和评论，保存为 JSON
 */
class CollectRedditBloggerStep extends BaseStep {
  get name() { return 'collect-reddit-blogger' }
  get description() { return '采集 Reddit 博主的帖子和评论数据，保存为 JSON 文件' }
  get category() { return 'collection' }
  get timeout() { return 60_000 }
  get requires() { return ['input'] }
  get provides() { return ['bloggerData'] }

  async execute(context, stepDef) {
    const input = (context.get('input') || '').trim()
    // 从输入中提取用户名（支持 "用户名" 或 "reddit 用户名" 格式）
    const username = input.replace(/^reddit\s+/i, '').trim()

    if (!username) {
      return { ok: false, error: '请提供 Reddit 用户名，例如：CompanyCharts' }
    }

    logger.info({ username }, '📡 开始采集 Reddit 博主数据')

    const limits = stepDef.limits || { posts: 100, comments: 100 }

    try {
      // 并行采集帖子和评论
      const [posts, comments] = await Promise.all([
        this._fetchPosts(username, limits.posts),
        this._fetchComments(username, limits.comments),
      ])

      // 统计
      const subredditCounts = {}
      for (const p of posts) {
        const sub = p.subreddit || 'unknown'
        subredditCounts[sub] = (subredditCounts[sub] || 0) + 1
      }
      for (const c of comments) {
        const sub = c.subreddit || 'unknown'
        subredditCounts[sub] = (subredditCounts[sub] || 0) + 1
      }

      const bloggerData = {
        username,
        platform: 'reddit',
        collectedAt: new Date().toISOString(),
        posts,
        comments,
        stats: {
          postCount: posts.length,
          commentCount: comments.length,
          topSubreddits: Object.entries(subredditCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => ({ name, count })),
        },
      }

      // 保存到文件
      const outputDir = path.join(process.env.HOME, '.openclaw/workspace/docs/blogger-data')
      fs.mkdirSync(outputDir, { recursive: true })
      const filePath = path.join(outputDir, `${username.toLowerCase()}.json`)
      fs.writeFileSync(filePath, JSON.stringify(bloggerData, null, 2))

      logger.info({
        username,
        posts: posts.length,
        comments: comments.length,
        path: filePath,
      }, '✅ Reddit 博主数据采集完成')

      return { ok: true, output: bloggerData }
    } catch (err) {
      logger.error({ username, err: err.message }, '❌ Reddit 博主数据采集失败')
      return { ok: false, error: err.message }
    }
  }

  async _fetchPosts(username, limit) {
    const url = `https://arctic-shift.photon-reddit.com/api/posts/search?author=${encodeURIComponent(username)}&limit=${limit}&sort=desc`
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`帖子采集 HTTP ${res.status}`)
    const data = await res.json()
    return (data.data || [])
      .filter(p => p.selftext && p.selftext !== '[removed]' && p.selftext !== '[deleted]')
      .map(p => ({
        title: p.title || '',
        content: (p.selftext || '').slice(0, 3000),
        score: p.score || 0,
        url: `https://reddit.com${p.permalink || ''}`,
        subreddit: p.subreddit || '',
        createdAt: new Date((p.created_utc || 0) * 1000).toISOString(),
      }))
  }

  async _fetchComments(username, limit) {
    const url = `https://arctic-shift.photon-reddit.com/api/comments/search?author=${encodeURIComponent(username)}&limit=${limit}&sort=desc`
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`评论采集 HTTP ${res.status}`)
    const data = await res.json()
    return (data.data || [])
      .filter(c => c.body && c.body !== '[removed]' && c.body !== '[deleted]')
      .map(c => ({
        content: (c.body || '').slice(0, 2000),
        score: c.score || 0,
        url: `https://reddit.com${c.permalink || ''}`,
        subreddit: c.subreddit || '',
        createdAt: new Date((c.created_utc || 0) * 1000).toISOString(),
      }))
  }
}

module.exports = CollectRedditBloggerStep

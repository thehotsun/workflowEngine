'use strict'

const { describe, it, expect, beforeEach } = require('@jest/globals')

// Mock openclaw client
jest.mock('../../openclaw/client', () => ({
  invokeTool: jest.fn(),
  sendMessage: jest.fn(),
}))

// Mock model router
jest.mock('../../models/router', () => ({
  route: jest.fn(() => ({
    chat: jest.fn().mockResolvedValue({
      content: '[{"idx":0,"score":7,"reason":"有数据分析"}]',
      usage: { total_tokens: 100 },
    }),
  })),
}))

const openclawClient = require('../../openclaw/client')
const modelRouter = require('../../models/router')

describe('Financial Intel Steps', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ─── 采集层 ────────────────────────────────────────

  describe('CollectRedditStep', () => {
    const CollectRedditStep = require('../../steps/collection/collect-reddit.step')
    const step = new CollectRedditStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('collect-reddit')
      expect(step.description).toContain('Reddit')
      expect(step.category).toBe('collection')
      expect(step.timeout).toBe(90000)
    })

    it('should extract subreddit from URL', () => {
      expect(step._extractSubreddit('https://reddit.com/r/wallstreetbets/comments/123')).toBe('wallstreetbets')
      expect(step._extractSubreddit('https://reddit.com/r/ValueInvesting')).toBe('ValueInvesting')
      expect(step._extractSubreddit('https://example.com')).toBe('')
    })

    it('should return empty array when no data', async () => {
      openclawClient.invokeTool.mockResolvedValue({ results: [] })
      // Mock fetch for PullPush.io
      const origFetch = global.fetch
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 })
      const context = { get: jest.fn(() => ({})), set: jest.fn() }
      const result = await step.execute(context, {})
      expect(result.ok).toBe(true)
      expect(result.output).toEqual([])
      global.fetch = origFetch
    })
  })

  describe('CollectTwitterStep', () => {
    const CollectTwitterStep = require('../../steps/collection/collect-twitter.step')
    const step = new CollectTwitterStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('collect-twitter')
      expect(step.description).toContain('X/Twitter')
      expect(step.category).toBe('collection')
    })
  })

  describe('CollectDiscordStep', () => {
    const CollectDiscordStep = require('../../steps/collection/collect-discord.step')
    const step = new CollectDiscordStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('collect-discord')
      expect(step.description).toContain('Discord')
      expect(step.category).toBe('collection')
    })
  })

  // ─── 分析层 ────────────────────────────────────────

  describe('ScorePlatformBase', () => {
    const ScoreRedditStep = require('../../steps/analysis/score-reddit.step')
    const step = new ScoreRedditStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('score-reddit')
      expect(step.description).toContain('Reddit')
      expect(step.category).toBe('analysis')
      expect(step.platformKey).toBe('redditItems')
      expect(step.platformLabel).toBe('Reddit')
    })

    it('should calculate platform score', () => {
      expect(step._calcPlatformScore({ score: 100, num_comments: 50 })).toBeGreaterThan(0)
      expect(step._calcPlatformScore({ score: 0, num_comments: 0 })).toBe(5)  // 无数据时给默认 5 分
      expect(step._calcPlatformScore({ score: 1000, num_comments: 200 })).toBeLessThanOrEqual(10)
    })

    it('should parse LLM evaluations', () => {
      const evals = step._parseEvaluations('[{"idx":0,"answers":[1,1,0,1,0,0,1,0,1,0],"reason":"good"}]', 1)
      expect(evals).toHaveLength(1)
      expect(evals[0].answers).toHaveLength(10)
      expect(evals[0].answers[0]).toBe(1)
    })

    it('should fallback on parse failure', () => {
      const evals = step._parseEvaluations('invalid', 3)
      expect(evals).toHaveLength(3)
      expect(evals[0].answers).toHaveLength(10)
      expect(evals[0].answers[0]).toBe(0)
    })

    it('should handle empty platform data gracefully', async () => {
      const context = { get: jest.fn(() => ({})) }
      const result = await step.execute(context, {})
      expect(result.ok).toBe(true)
      expect(result.output).toEqual([])
    })

    it('should fallback on LLM error', async () => {
      modelRouter.route.mockReturnValue({
        chat: jest.fn().mockRejectedValue(new Error('LLM timeout')),
      })
      const context = {
        get: jest.fn((key) => {
          if (key === 'platformData') return { redditItems: [{ title: 'test', score: 10, num_comments: 5 }] }
          if (key === '_config') return {}
          return {}
        }),
      }
      const result = await step.execute(context, {})
      expect(result.ok).toBe(true)
      expect(result.output[0].scoring.method).toBe('fallback')
    })
  })

  describe('ScoreTwitterStep', () => {
    const ScoreTwitterStep = require('../../steps/analysis/score-twitter.step')
    const step = new ScoreTwitterStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('score-twitter')
      expect(step.platformKey).toBe('twitterItems')
    })
  })

  describe('ScoreDiscordStep', () => {
    const ScoreDiscordStep = require('../../steps/analysis/score-discord.step')
    const step = new ScoreDiscordStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('score-discord')
      expect(step.platformKey).toBe('discordItems')
    })
  })

  // ─── 处理层 ────────────────────────────────────────

  describe('MergeDataStep', () => {
    const MergeDataStep = require('../../steps/processing/merge-data.step')
    const step = new MergeDataStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('merge-data')
      expect(step.description).toContain('合并')
    })

    it('should merge arrays correctly', async () => {
      const context = {
        get: jest.fn((key) => {
          if (key === 'parallelResults') return [[{ title: 'reddit' }], [{ title: 'twitter' }], [{ title: 'discord' }]]
          return null
        }),
      }
      const result = await step.execute(context, {
        input: (ctx) => ({
          reddit: ctx.get('parallelResults')[0],
          twitter: ctx.get('parallelResults')[1],
          discord: ctx.get('parallelResults')[2],
        }),
      })
      expect(result.ok).toBe(true)
      expect(result.output).toHaveLength(3)
    })

    it('should handle null results gracefully', async () => {
      const context = {
        get: jest.fn(() => [null, [{ title: 'ok' }], null]),
      }
      const result = await step.execute(context, {
        input: (ctx) => {
          const r = ctx.get('parallelResults')
          return { reddit: r[0] || [], twitter: r[1] || [], discord: r[2] || [] }
        },
      })
      expect(result.ok).toBe(true)
      expect(result.output).toHaveLength(1)
    })
  })

  describe('MergeScoredStep', () => {
    const MergeScoredStep = require('../../steps/processing/merge-scored.step')
    const step = new MergeScoredStep()

    it('should merge and sort by score', async () => {
      const context = { get: jest.fn() }
      const result = await step.execute(context, {
        input: () => ({
          redditScored: [{ title: 'r1', score: 5 }],
          twitterScored: [{ title: 't1', score: 8 }],
          discordScored: [],
        }),
      })
      expect(result.ok).toBe(true)
      expect(result.output).toHaveLength(2)
      expect(result.output[0].score).toBe(8)  // sorted by score desc
      expect(result.output[1].score).toBe(5)
    })
  })

  describe('FilterThresholdStep', () => {
    const FilterThresholdStep = require('../../steps/processing/filter-threshold.step')
    const step = new FilterThresholdStep()

    it('should filter by threshold', async () => {
      const context = { get: jest.fn() }
      const result = await step.execute(context, {
        input: () => ({
          items: [
            { title: 'high', score: 8 },
            { title: 'medium', score: 5 },
            { title: 'low', score: 2 },
          ],
          threshold: 5.0,
        }),
      })
      expect(result.ok).toBe(true)
      expect(result.output).toHaveLength(2)
      expect(result.output[0].title).toBe('high')
    })

    it('should return empty when nothing passes', async () => {
      const context = { get: jest.fn() }
      const result = await step.execute(context, {
        input: () => ({
          items: [{ title: 'low', score: 1 }],
          threshold: 5.0,
        }),
      })
      expect(result.ok).toBe(true)
      expect(result.output).toHaveLength(0)
    })
  })

  // ─── 输出层 ────────────────────────────────────────

  describe('PublishIntelStep', () => {
    const PublishIntelStep = require('../../steps/output/publish-intel.step')
    const step = new PublishIntelStep()

    it('should have correct metadata', () => {
      expect(step.name).toBe('publish-intel')
      expect(step.description).toContain('推送')
    })

    it('should format message correctly', () => {
      const message = step._formatMessage([
        { title: 'Test', coreSummary: 'Summary', url: 'http://test.com', score: 8.5, source: 'reddit' },
      ])
      expect(message).toContain('Test')
      expect(message).toContain('Summary')
      expect(message).toContain('8.5')
    })

    it('should handle empty items', () => {
      const message = step._formatMessage([])
      expect(message).toContain('今日高质量金融信息')
    })
  })

  // ─── 并行容错 ────────────────────────────────────────

  describe('Parallel Step Failure Tolerance', () => {
    it('should continue when some sub-steps fail', async () => {
      const ParallelStep = require('../../steps/flow-control/parallel.step')
      const step = new ParallelStep({ steps: [] })

      // 模拟 3 个子步骤，1 个失败
      const results = [
        { status: 'fulfilled', value: { output: [{ title: 'ok1' }] } },
        { status: 'rejected', reason: { message: 'timeout' } },
        { status: 'fulfilled', value: { output: [{ title: 'ok2' }] } },
      ]

      const succeeded = results.filter(r => r.status === 'fulfilled')
      const failed = results.filter(r => r.status === 'rejected')

      expect(succeeded.length).toBe(2)
      expect(failed.length).toBe(1)

      // 模拟 parallel step 的容错逻辑
      const output = results.map(r => r.status === 'fulfilled' ? r.value?.output : null)
      expect(output[0]).toEqual([{ title: 'ok1' }])
      expect(output[1]).toBeNull()
      expect(output[2]).toEqual([{ title: 'ok2' }])
    })
  })
})

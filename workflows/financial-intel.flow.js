'use strict'

/**
 * ==============================
 * 金融信息采集分析流程 v3
 * ==============================
 * 
 * 专注 A 股和行业报告，六大数据源：
 * 1. Reddit (Arctic Shift) — 海外散户情绪参考
 * 2. 雪球 — A 股深度分析和投资策略
 * 3. 东方财富 — A 股研报和宏观分析
 * 4. 同花顺 — 行业研报和景气度分析
 * 5. Substack — 全球宏观视野（少量）
 * 6. X/Twitter — 实时市场动态
 * 
 * 去重 → 评分 → 过滤 → 分析 → 推送
 */

module.exports = {
  id: 'financial_intel',
  enabled: true,
  name: '金融信息采集分析 v3（A股专注）',

  config: {
    reddit: {
      subreddits: ['ValueInvesting', 'investing', 'stocks', 'wallstreetbets', 'StockMarket'],
      limitPerSub: 15,
    },
    xueqiu: {
      queries: ['A股 深度分析 投资策略', '行业分析 估值 低估', '个股分析 基本面'],
      count: 5,
      freshness: 'week',
    },
    eastmoney: {
      queries: ['深度分析 研报', 'A股 行业分析', '价值投资 低估'],
      count: 5,
      freshness: 'week',
    },
    tonghuashun: {
      queries: ['行业分析 研报 2026', 'A股 行业景气度', '券商 策略 观点'],
      count: 5,
      freshness: 'week',
    },
    substack: {
      queries: ['China market A-share outlook', 'global macro investing'],
      count: 3,
      freshness: 'month',
    },
    twitter: {
      queries: ['A股 market analysis twitter', 'China stock market outlook twitter', 'global macro analysis 2026'],
      count: 3,
      freshness: 'week',
    },
    quality: {
      threshold: 3.0,  // 10 问题制下，3 分 = 2-3 个"是"
    },
    scoreReddit: {
      model: { taskType: 'analysis' },
      temperature: 0.3,
      maxTokens: 1500,
      persona: '你是金融分析评估专家。Reddit 内容偏散户情绪，重点看是否有独特视角或数据。',
    },
    scoreXueqiu: {
      model: { taskType: 'analysis' },
      temperature: 0.3,
      maxTokens: 1000,
      persona: '你是A股分析评估专家。雪球内容通常质量较高，关注分析深度、数据支撑、逻辑完整性。',
    },
    scoreEastmoney: {
      model: { taskType: 'analysis' },
      temperature: 0.3,
      maxTokens: 1000,
      persona: '你是A股分析评估专家。东方财富研报质量高，关注行业趋势判断和个股推荐逻辑。',
    },
    scoreTonghuashun: {
      model: { taskType: 'analysis' },
      temperature: 0.3,
      maxTokens: 1000,
      persona: '你是行业分析评估专家。同花顺研报关注行业景气度和投资机会。',
    },
    scoreSubstack: {
      model: { taskType: 'analysis' },
      temperature: 0.3,
      maxTokens: 1000,
    },
    scoreTwitter: {
      model: { taskType: 'analysis' },
      temperature: 0.3,
      maxTokens: 1000,
    },
    filterAndSummarize: {
      model: { taskType: 'analysis' },
      temperature: 0.4,
      maxTokens: 2000,
      persona: '你是金融信息编辑。用3-5句话精炼金融文章的核心信息，让读者30秒内抓住要点。**必须用中文输出，即使原文是英文也要翻译成中文。**',
    },
  },

  trigger: {
    schedule: '0 9 * * *',
    match: /金融采集|金融信息|采集分析/,
    // 支持手动触发
    source: 'manual',
    manual: true,
  },

  steps: [
    // Step 1: 六源并行采集
    {
      type: 'parallel',
      output: 'collected',
      steps: [
        { type: 'collect-reddit-arctic' },
        { type: 'collect-xueqiu' },
        { type: 'collect-eastmoney' },
        { type: 'collect-tonghuashun' },
        { type: 'collect-substack' },
        { type: 'collect-twitter' },
      ],
    },

    // Step 2: 拆分各源数据 + 按 URL 去重（在评分前去重，避免重复消耗 LLM token）
    {
      type: 'transform',
      run: ctx => {
        const r = ctx.get('collected') || []
        const platformData = {
          redditItems: Array.isArray(r[0]) ? r[0] : [],
          xueqiuItems: Array.isArray(r[1]) ? r[1] : [],
          eastmoneyItems: Array.isArray(r[2]) ? r[2] : [],
          tonghuashunItems: Array.isArray(r[3]) ? r[3] : [],
          substackItems: Array.isArray(r[4]) ? r[4] : [],
          twitterItems: Array.isArray(r[5]) ? r[5] : [],
        }
        // 每个平台内部按 URL 去重
        for (const [key, items] of Object.entries(platformData)) {
          const seen = new Set()
          platformData[key] = items.filter(item => {
            const url = item.url || item.title
            if (!url || seen.has(url)) return false
            seen.add(url)
            return true
          })
        }
        return { platformData }
      },
    },

    // Step 3: 并行评分（6 个平台独立评分）
    {
      type: 'parallel',
      output: 'scored',
      timeout: 300000,
      steps: [
        { type: 'score-reddit', timeout: 120000 },
        { type: 'score-xueqiu', timeout: 120000 },
        { type: 'score-eastmoney', timeout: 120000 },
        { type: 'score-tonghuashun', timeout: 120000 },
        { type: 'score-substack', timeout: 120000 },
        { type: 'score-twitter', timeout: 120000 },
      ],
    },

    // Step 4: 合并所有评分结果
    {
      type: 'merge-scored',
      input: ctx => {
        const r = ctx.get('scored') || []
        return {
          redditScored: Array.isArray(r[0]) ? r[0] : [],
          xueqiuScored: Array.isArray(r[1]) ? r[1] : [],
          eastmoneyScored: Array.isArray(r[2]) ? r[2] : [],
          tonghuashunScored: Array.isArray(r[3]) ? r[3] : [],
          substackScored: Array.isArray(r[4]) ? r[4] : [],
          twitterScored: Array.isArray(r[5]) ? r[5] : [],
        }
      },
      output: 'allScored',
    },

    // Step 5: URL 去重
    {
      type: 'deduplicate',
      input: ctx => ctx.get('allScored') || [],
      output: 'allScored',
    },

    // Step 6: 阈值过滤
    {
      type: 'filter-threshold',
      input: ctx => ({
        items: ctx.get('allScored') || [],
        threshold: ctx.get('_config')?.quality?.threshold || 5.0,
      }),
      output: 'highQualityItems',
    },

    // Step 7: 推送阈值（决定是否值得推送）
    {
      type: 'push-threshold',
      output: 'pushDecision',
    },

    // Step 8: 专业金融分析（A 股视角）
    {
      type: 'analyze-finance',
      requires: ['highQualityItems'],
      output: 'financeAnalysis',
      condition: ctx => ctx.get('pushDecision')?.shouldPush !== false,
    },

    // Step 9: 核心提炼
    {
      type: 'filter-and-summarize',
      requires: ['highQualityItems'],
      output: 'finalDigest',
      condition: ctx => ctx.get('pushDecision')?.shouldPush !== false,
    },

    // Step 10: 推送
    {
      type: 'publish-intel',
      requires: ['finalDigest', 'financeAnalysis'],
      condition: ctx => ctx.get('pushDecision')?.shouldPush !== false,
    },

    // Step 11: 存档
    {
      type: 'archive-articles',
      condition: ctx => ctx.get('pushDecision')?.shouldPush !== false,
    },
  ],

  onError: 'pause',
}

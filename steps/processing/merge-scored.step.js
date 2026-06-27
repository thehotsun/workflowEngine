'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')

/**
 * 合并各平台评分结果 Step
 * 将 Reddit/Twitter/Discord 的独立评分结果合并为一个列表
 * 容错：某个平台为空或失败不影响其他平台
 */
class MergeScoredStep extends BaseStep {
  get name() { return 'merge-scored' }
  get description() { return '合并各平台评分结果' }
  get category() { return 'processing' }

  async execute(context, stepDef) {
    const input = typeof stepDef.input === 'function'
      ? stepDef.input(context)
      : stepDef.input || {}

    const reddit = input.redditScored || []
    const xueqiu = input.xueqiuScored || []
    const eastmoney = input.eastmoneyScored || []
    const tonghuashun = input.tonghuashunScored || []
    const substack = input.substackScored || []
    const twitter = input.twitterScored || []

    const allItems = [...reddit, ...xueqiu, ...eastmoney, ...tonghuashun, ...substack, ...twitter]

    // 按分数排序
    allItems.sort((a, b) => (b.score || 0) - (a.score || 0))

    logger.info({
      reddit: reddit.length,
      xueqiu: xueqiu.length,
      eastmoney: eastmoney.length,
      tonghuashun: tonghuashun.length,
      substack: substack.length,
      twitter: twitter.length,
      total: allItems.length,
    }, '📊 各平台评分结果合并完成')

    return { ok: true, output: allItems }
  }
}

module.exports = MergeScoredStep

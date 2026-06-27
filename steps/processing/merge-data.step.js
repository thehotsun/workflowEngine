'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')

/**
 * 数据合并 Step
 * 将三个平台的原始数据合并为一个列表
 */
class MergeDataStep extends BaseStep {
  get name() { return 'merge-data' }
  get description() { return '合并三个平台的采集数据' }
  get category() { return 'processing' }

  async execute(context, stepDef) {
    const input = typeof stepDef.input === 'function'
      ? stepDef.input(context)
      : stepDef.input || {}

    const reddit = input.reddit || []
    const twitter = input.twitter || []
    const discord = input.discord || []

    const allItems = [...reddit, ...twitter, ...discord]

    logger.info({
      reddit: reddit.length,
      twitter: twitter.length,
      discord: discord.length,
      total: allItems.length,
    }, '📊 数据合并完成')

    return { ok: true, output: allItems }
  }
}

module.exports = MergeDataStep

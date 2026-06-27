'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')

/**
 * 推送阈值 Step
 * 根据新文章数量和质量决定是否推送
 * 
 * 规则：
 * - 0 条 → 不推送
 * - 1-2 条 → 只有评分 ≥ 8 才推送
 * - 3-5 条 → 正常推送（评分 ≥ 5）
 * - 6+ 条 → 推送 Top 5
 */
class PushThresholdStep extends BaseStep {
  get name() { return 'push-threshold' }
  get description() { return '推送阈值：决定是否值得推送' }
  get category() { return 'processing' }
  get timeout() { return 3000 }

  async execute(context, stepDef) {
    const items = context.get('highQualityItems') || []
    const count = items.length

    // 按分数排序（高→低）
    const sorted = [...items].sort((a, b) => (b.score || 0) - (a.score || 0))

    let shouldPush = false
    let filteredItems = []
    let reason = ''

    if (count === 0) {
      reason = '无新内容'
    } else {
      // 只看质量不看数量：全部推送
      shouldPush = true
      filteredItems = sorted
      reason = `${count} 篇高质量文章`
    }

    logger.info({
      total: count,
      shouldPush,
      filtered: filteredItems.length,
      topScore: sorted[0]?.score?.toFixed(1),
      reason,
    }, `📊 推送决策：${shouldPush ? '推送' : '跳过'} — ${reason}`)

    return {
      ok: true,
      output: {
        shouldPush,
        items: filteredItems,
        reason,
        originalCount: count,
      },
    }
  }
}

module.exports = PushThresholdStep

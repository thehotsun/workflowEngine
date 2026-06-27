'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')

/**
 * 阈值过滤 Step
 * 只保留超过质量阈值的内容（无配额限制）
 */
class FilterThresholdStep extends BaseStep {
  get name() { return 'filter-threshold' }
  get description() { return '按质量阈值过滤' }
  get category() { return 'processing' }

  async execute(context, stepDef) {
    const input = typeof stepDef.input === 'function'
      ? stepDef.input(context)
      : stepDef.input || {}

    const items = input.items || []
    const threshold = input.threshold || 5.0

    const passed = items.filter(item => (item.score || 0) >= threshold)
    const rejected = items.length - passed.length

    // 来源分布
    const passedBySource = {}
    const rejectedBySource = {}
    for (const item of items) {
      const src = item.source || 'unknown'
      if ((item.score || 0) >= threshold) {
        passedBySource[src] = (passedBySource[src] || 0) + 1
      } else {
        rejectedBySource[src] = (rejectedBySource[src] || 0) + 1
      }
    }

    logger.info({
      total: items.length,
      passed: passed.length,
      rejected,
      threshold,
      passedBySource,
      rejectedBySource,
    }, `🔽 过滤完成：${passed.length}/${items.length} 通过阈值 ${threshold}`)

    return { ok: true, output: passed }
  }
}

module.exports = FilterThresholdStep

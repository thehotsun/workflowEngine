'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')

/**
 * 轻量数据变换 step
 * workflow 示例:
 * {
 *   type: 'transform',
 *   run: (ctx) => ({ prompt: `请总结：${ctx.get('input')}` })
 * }
 *
 * @workflow-config
 * - 无需配置，行为由 stepDef.run 函数控制
 *
 * @requires [] - 无固定依赖（由 stepDef.run 决定）
 * @provides [] - 无固定输出（由 stepDef.run 返回值决定）
 */
class TransformStep extends BaseStep {
  get name() { return 'transform' }
  get description() { return '执行轻量数据转换函数 stepDef.run(context)，用于拼装或改写上下文数据' }
  get category() { return 'flow-control' }
  get retryable() { return false }

  async execute(context, stepDef) {
    if (typeof stepDef.run !== 'function') {
      throw new Error('transform step requires stepDef.run(context)')
    }

    logger.info('🔄 transform: 开始转换')
    const output = await stepDef.run(context)
    // 输出每个 key 的条数，方便追踪流水线
    const counts = {}
    for (const [key, val] of Object.entries(output || {})) {
      if (Array.isArray(val)) counts[key] = val.length
      else if (typeof val === 'object' && val !== null) {
        counts[key] = Object.keys(val).length + ' keys'
      }
    }
    logger.info({ outputKeys: Object.keys(output || {}), counts }, '✅ transform: 转换完成')

    return { ok: true, output: output || {} }
  }
}

module.exports = TransformStep

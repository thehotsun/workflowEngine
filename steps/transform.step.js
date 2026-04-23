'use strict'

const BaseStep = require('./base.step')

/**
 * 轻量数据变换 step
 * workflow 示例:
 * {
 *   type: 'transform',
 *   run: (ctx) => ({ prompt: `请总结：${ctx.get('input')}` })
 * }
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

    const output = await stepDef.run(context)
    return { ok: true, output: output || {} }
  }
}

module.exports = TransformStep

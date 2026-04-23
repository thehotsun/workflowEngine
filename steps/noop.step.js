'use strict'

const BaseStep = require('./base.step')

/**
 * 占位 step，不做任何事
 */
class NoopStep extends BaseStep {
  get name() { return 'noop' }
  get description() { return '空操作占位，直接返回，不修改 context；用于流程测试或临时跳过某步骤' }
  get category() { return 'flow-control' }
  get retryable() { return false }

  async execute() {
    return { ok: true, output: { noop: true } }
  }
}

module.exports = NoopStep

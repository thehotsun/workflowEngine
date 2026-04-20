'use strict'

const BaseStep = require('./base.step')

/**
 * 占位 step，不做任何事
 */
class NoopStep extends BaseStep {
  get name() { return 'noop' }
  get retryable() { return false }

  async execute() {
    return { ok: true, output: { noop: true } }
  }
}

module.exports = NoopStep

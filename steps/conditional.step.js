'use strict'

const BaseStep = require('./base.step')

/**
 * 条件分支 step
 * workflow 示例:
 * {
 *   type: 'conditional',
 *   condition: (ctx) => ctx.get('ragResults', []).length > 0,
 *   ifTrue:  { type: 'write' },
 *   ifFalse: { type: 'skill-proxy', skill: 'web-search', ... }
 * }
 */
class ConditionalStep extends BaseStep {
  constructor({ engine, workflow, conversation }) {
    super()
    this._engine = engine
    this._workflow = workflow
    this._conversation = conversation
  }

  get name() { return 'conditional' }
  get retryable() { return false }

  async execute(context, stepDef) {
    if (typeof stepDef.condition !== 'function') {
      throw new Error('conditional step requires stepDef.condition(context)')
    }

    const runId = context.get('_runId')
    const parentIndex = context.get('_currentStepIndex', -1)
    const result = await stepDef.condition(context)
    const branchDef = result ? stepDef.ifTrue : stepDef.ifFalse

    if (!branchDef) {
      return { ok: true, output: { branch: result ? 'true' : 'false', skipped: true } }
    }

    // 子步骤使用 -(parentIndex + 1) 作为 stepIndex 以区分顶层 step，
    // 负数保证 recoverRuns 的 topLevelCompleted 过滤（step_index < workflow.steps.length）正常生效
    const branchResult = await this._engine.runStep({
      stepDef: branchDef,
      stepIndex: -(parentIndex + 1),
      context,
      runId,
      conversation: this._conversation,
      workflow: this._workflow
    })

    return { ok: true, output: branchResult?.output }
  }
}

module.exports = ConditionalStep

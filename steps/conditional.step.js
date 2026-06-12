'use strict'

const BaseStep = require('./base.step')
const logger = require('../utils/logger')

/**
 * 条件分支 step
 * workflow 示例:
 * {
 *   type: 'conditional',
 *   condition: (ctx) => ctx.get('ragResults', []).length > 0,
 *   ifTrue:  { type: 'write' },
 *   ifFalse: { type: 'skill-proxy', skill: 'web-search', ... }
 * }
 *
 * @workflow-config
 * - 无需配置，行为由 stepDef.condition/ifTrue/ifFalse 控制
 *
 * @requires [] - 无固定依赖（由 stepDef.condition 决定）
 * @provides [] - 无固定输出（由分支子步骤决定）
 */
class ConditionalStep extends BaseStep {
  constructor({ engine, workflow, conversation }) {
    super()
    this._engine = engine
    this._workflow = workflow
    this._conversation = conversation
  }

  get name() { return 'conditional' }
  get description() { return '条件分支：根据 context 动态选择执行 ifTrue 或 ifFalse 子步骤' }
  get category() { return 'flow-control' }
  get retryable() { return false }

  async execute(context, stepDef) {
    if (typeof stepDef.condition !== 'function') {
      throw new Error('conditional step requires stepDef.condition(context)')
    }

    const runId = context.get('_runId')
    const parentIndex = context.get('_currentStepIndex', -1)
    const result = await stepDef.condition(context)
    const branchDef = result ? stepDef.ifTrue : stepDef.ifFalse

    logger.info({ condition: result, hasBranch: !!branchDef }, '🔀 conditional: 条件判断')

    if (!branchDef) {
      logger.info('🔀 conditional: 无分支定义，跳过')
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

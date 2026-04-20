'use strict'

const BaseStep = require('./base.step')

/**
 * 并行执行多个子 step，等待所有完成后合并结果
 */
class ParallelStep extends BaseStep {
  constructor({ steps, engine, workflow, conversation }) {
    super()
    this._subStepDefs = steps || []
    this._engine = engine
    this._workflow = workflow
    this._conversation = conversation
  }

  get name() { return 'parallel' }
  get retryable() { return false }

  async execute(context) {
    const runId = context.get('_runId')
    if (!runId) throw new Error('parallel: missing _runId in context')

    const parentIndex = context.get('_currentStepIndex', -1)

    const tasks = this._subStepDefs.map((subStepDef, i) => {
      // 并行子步骤使用负数 stepIndex（以父 index 为基础），防止与顶层 step_index 冲突
      // 公式：-(parentIndex * 1000 + i + 1)，保证不同并行组的子 step 互不重叠
      const subIndex = -(parentIndex * 1000 + i + 1)
      // 每个子步骤使用独立的 context 快照，避免并发写入竞争
      const subContext = context.snapshot()
      return this._engine.runStep({
        stepDef: subStepDef,
        stepIndex: subIndex,
        context: subContext,
        runId,
        conversation: this._conversation,
        workflow: this._workflow
      })
    })

    const results = await Promise.allSettled(tasks)
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message)
      .filter(Boolean)

    if (errors.length) {
      throw new Error(`Parallel steps failed: ${errors.join('; ')}`)
    }

    return { ok: true, output: results.map(r => r.value?.output) }
  }
}

module.exports = ParallelStep

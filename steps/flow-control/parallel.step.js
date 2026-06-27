'use strict'

const BaseStep = require('../base.step')
const logger = require('../../utils/logger')

/**
 * 并行执行多个子 step，等待所有完成后合并结果
 *
 * @workflow-config
 * - 无需配置
 *
 * @requires ['_runId'] - 运行 ID
 * @provides [] - 子步骤结果数组
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
  get description() { return '并行执行多个子步骤，等待全部完成后汇总结果；子步骤使用独立 context 快照防并发冲突' }
  get category() { return 'flow-control' }
  get retryable() { return false }

  async execute(context) {
    const runId = context.get('_runId')
    if (!runId) throw new Error('parallel: missing _runId in context')

    const parentIndex = context.get('_currentStepIndex', -1)
    const taskCount = this._subStepDefs.length

    logger.info({ taskCount }, '⚡ parallel: 开始并行执行')

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
    const succeeded = results
      .map((r, i) => r.status === 'fulfilled' ? { index: i, step: this._subStepDefs[i]?.type } : null)
      .filter(Boolean)
    const failed = results
      .map((r, i) => r.status === 'rejected' ? { index: i, step: this._subStepDefs[i]?.type, error: r.reason?.message } : null)
      .filter(Boolean)

    // 记录每个子步骤的结果
    for (const s of succeeded) {
      logger.info({ index: s.index, step: s.step }, `✅ parallel: ${s.step} 成功`)
    }
    for (const f of failed) {
      logger.warn({ index: f.index, step: f.step, error: f.error }, `❌ parallel: ${f.step} 失败`)
    }

    // 如果全部失败，才抛错
    if (succeeded.length === 0 && taskCount > 0) {
      throw new Error(`All parallel steps failed: ${failed.map(f => f.error).join('; ')}`)
    }

    logger.info({
      succeeded: succeeded.map(s => s.step),
      failed: failed.map(f => f.step),
      total: taskCount,
    }, '✅ parallel: 并行执行完成')

    // 返回成功结果，失败的位置填 null
    const output = results.map(r => r.status === 'fulfilled' ? r.value?.output : null)
    return { ok: true, output, _partialFailure: failed.length > 0, _failures: failed }
  }
}

module.exports = ParallelStep

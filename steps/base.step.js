'use strict'

class BaseStep {
  get name() {
    throw new Error('Step must implement get name()')
  }

  // Step 自描述：用于 AI 编排与能力目录
  get description() {
    return '未声明 Step 功能描述'
  }

  // Step 分类：用于能力检索与流程编排
  get category() {
    return 'uncategorized'
  }

  // 是否可以重试
  get retryable() {
    return true
  }

  // 默认超时 ms
  get timeout() {
    return 30_000
  }

  /**
   * 声明此 step 依赖 context 中的哪些 key（可选）。
   * engine 在执行前会检查这些 key 是否存在，如缺失则抛出 StepInputError（不重试）。
   * 子类按需 override，返回 string[]。
   * @returns {string[]}
   */
  get requires() {
    return []
  }

  /**
   * 声明此 step 执行后会向 context 写入哪些 key（文档用途，可选）。
   * @returns {string[]}
   */
  get provides() {
    return []
  }

  /**
   * 执行 step
   * @param {import('../core/context')} context
   * @param {object} stepDef - workflow 中的 step 定义
   * @returns {Promise<{ok: boolean, output: any, usage?: {total_tokens: number}}>}
   */
  async execute(context, stepDef) {
    throw new Error('Step must implement execute(context, stepDef)')
  }
}

module.exports = BaseStep

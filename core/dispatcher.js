'use strict'

const logger = require('../utils/logger')
const { createChildLogger } = require('../utils/child-logger')

/**
 * 按顺序调度执行 workflow 的 steps。
 *
 * 支持 step 级别 onError 策略：
 * - 'fail'（默认）：错误向上传播，由 runWorkflow 决定最终处理
 * - 'pause'：将错误标记为 _stepOnError='pause'，由 runWorkflow catch 转为 waiting
 * - 'skip'：记录错误日志后继续执行下一步骤
 */
async function dispatchSteps({ steps, engine, context, runId, conversation, workflow }) {
  const dispatchLog = createChildLogger({ runId, workflowId: workflow?.id })
  for (let index = 0; index < steps.length; index++) {
    const stepDef = steps[index]

    try {
      const result = await engine.runStep({
        stepDef,
        stepIndex: index,
        context,
        runId,
        conversation,
        workflow
      })

      // 如果步骤返回 _wait 标记，停止执行后续步骤
      if (result && result._wait) {
        return
      }
    } catch (err) {
      // step 级别 onError 优先于 workflow 级别
      const stepOnError = stepDef.onError || workflow?.onError || 'fail'

      if (stepOnError === 'skip') {
        dispatchLog.warn(
          { stepName: err.stepName || stepDef.type, stepIndex: index, err: err.message },
          '⚠️ Step failed, skipping (onError=skip)'
        )
        continue
      }

      if (stepOnError === 'pause') {
        // 标记 _stepOnError，供 runWorkflow catch 识别并转为 waiting
        err._stepOnError = 'pause'
      }

      throw err
    }
  }
}

module.exports = { dispatchSteps }

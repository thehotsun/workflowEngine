'use strict'

async function dispatchSteps({ steps, engine, context, runId, conversation, workflow }) {
  for (let index = 0; index < steps.length; index++) {
    const result = await engine.runStep({
      stepDef: steps[index],
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
  }
}

module.exports = { dispatchSteps }

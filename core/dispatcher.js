'use strict'

async function dispatchSteps({ steps, engine, context, runId, conversation, workflow }) {
  for (let index = 0; index < steps.length; index++) {
    await engine.runStep({
      stepDef: steps[index],
      stepIndex: index,
      context,
      runId,
      conversation,
      workflow
    })
  }
}

module.exports = { dispatchSteps }

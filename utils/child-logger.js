'use strict'

const logger = require('./logger')

/**
 * 创建带上下文的子日志器。
 *
 * 用法：
 *   const { createChildLogger } = require('./utils/child-logger')
 *   const log = createChildLogger({ runId, eventId, stepName, stepIndex })
 *   log.info('Step started')  // 自动附带 runId/eventId/stepName/stepIndex
 *
 * 所有字段均为可选；未传入的字段不会出现在日志中。
 * 返回的子日志器支持 .child() 追加更多字段。
 */
function createChildLogger(ctx = {}) {
  const bindings = {}
  if (ctx.runId != null) bindings.runId = ctx.runId
  if (ctx.eventId != null) bindings.eventId = ctx.eventId
  if (ctx.stepName != null) bindings.stepName = ctx.stepName
  if (ctx.stepIndex != null) bindings.stepIndex = ctx.stepIndex
  if (ctx.workflowId != null) bindings.workflowId = ctx.workflowId
  if (ctx.channelId != null) bindings.channelId = ctx.channelId

  if (Object.keys(bindings).length === 0) {
    return logger
  }
  return logger.child(bindings)
}

module.exports = { createChildLogger }

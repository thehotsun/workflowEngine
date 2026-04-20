'use strict'

const WorkflowContext = require('./context')
const { dispatchSteps } = require('./dispatcher')
const { assertTransition } = require('./state-machine')
const { withRetry } = require('./retry')
const { createRun, updateRunStatus, getRecoverableRuns, getRunById } = require('../persist/repos/workflow.repo')
const { createStepRun, updateStepRun, getCompletedStepRuns } = require('../persist/repos/step.repo')
const { markProcessing, markDone, markFailed } = require('../persist/repos/event.repo')
const { updateConversation, getOrCreateConversation } = require('../persist/repos/conversation.repo')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('../trigger/outbox-worker')
const { buildStep } = require('../steps')
const logger = require('../utils/logger')

class WorkflowEngine {
  constructor({ workflows }) {
    this.workflows = workflows || []
  }

  matchWorkflow(event) {
    return this.workflows.find(flow => {
      if (!flow.trigger) return false
      if (flow.trigger.type && flow.trigger.type !== event.triggerType) return false
      if (flow.trigger.match instanceof RegExp) return flow.trigger.match.test(event.text || '')
      return false
    })
  }

  async handleEvent({ event, conversation, inboxEventId }) {
    const workflow = this.matchWorkflow(event)
    if (!workflow) {
      logger.info({ inboxEventId }, 'No workflow matched event')
      return null
    }

    const effectiveEventId = inboxEventId || event.eventId
    const runId = createRun({
      workflowId: workflow.id,
      conversationId: conversation?.id,
      eventId: effectiveEventId,
      context: {}
    })

    const conversationHistory = loadConversationHistory(conversation)
    const initialContext = {
      _runId: runId,
      event,
      conversation,
      input: event.text,
      channelId: event.channelId,
      userId: event.userId,
      conversationHistory   // 多轮历史，供 step 注入 prompt
    }

    markProcessing(effectiveEventId, runId)
    await this.runWorkflow({ workflow, runId, contextData: initialContext, conversation, eventId: effectiveEventId })
    return runId
  }

  async runWorkflow({ workflow, runId, contextData, conversation, eventId }) {
    const context = new WorkflowContext({ ...contextData, _runId: runId })
    const now = Date.now()

    const currentRunAtStart = getRunById(runId)
    assertTransition(currentRunAtStart ? currentRunAtStart.status : 'pending', 'running')
    updateRunStatus(runId, 'running', { startedAt: now, context: context.toJSON() })

    try {
      await dispatchSteps({
        steps: workflow.steps,
        engine: this,
        context,
        runId,
        conversation,
        workflow
      })

      const currentRun = getRunById(runId)
      assertTransition(currentRun ? currentRun.status : 'running', 'done')
      updateRunStatus(runId, 'done', {
        finishedAt: Date.now(),
        context: context.toJSON()
      })

      if (conversation?.id) {
        const summary = buildConversationSummary(context)
        const prevHistory = loadConversationHistory(conversation)
        const updatedHistory = [...prevHistory, summary].slice(-10)   // 最多保留 10 条
        updateConversation(conversation.id, {
          lastRunId: runId,
          context: { history: updatedHistory }
        })
      }

      if (eventId) markDone(eventId)
    } catch (err) {
      logger.error({ runId, err: err.message }, 'Workflow failed')
      const failedRun = getRunById(runId)
      assertTransition(failedRun ? failedRun.status : 'running', 'failed')
      updateRunStatus(runId, 'failed', {
        finishedAt: Date.now(),
        error: err.message,
        context: context.toJSON()
      })
      if (eventId) markFailed(eventId, err.message)

      // P1-2: 处理 onError 策略
      if (workflow?.onError) {
        await this._handleOnError({ workflow, context, runId, err })
      }

      throw err
    }
  }

  async runStep({ stepDef, stepIndex, context, runId, conversation, workflow }) {
    context.set('_runId', runId)
    const prevCurrentStepIndex = context.get('_currentStepIndex')  // 保存父级 index，供 finally 恢复
    context.set('_currentStepIndex', stepIndex)
    const step = buildStep(stepDef, { engine: this, workflow, conversation })
    const stepName = step.name || stepDef.type || `step_${stepIndex}`

    // 约束校验：step.requires + stepDef.requires/dependsOn
    const requiredKeys = collectRequiredKeys(step, stepDef)
    assertRequiredContextKeys(context, requiredKeys, { stepName, stepIndex, workflowId: workflow?.id })

    const input = typeof stepDef.input === 'function' ? stepDef.input(context) : context.toJSON()
    const stepRunId = createStepRun({ runId, stepName, stepIndex, input })

    updateStepRun(stepRunId, { status: 'running', startedAt: Date.now() })
    updateRunStatus(runId, 'running', { currentStep: stepName, context: context.toJSON() })

    const started = Date.now()

    try {
      const result = await withRetry({
        fn: async () => this.executeWithTimeout(step, context, stepDef),
        stepName,
        runId,
        maxRetries: step.retryable === false ? 0 : (stepDef.maxRetries ?? 2)
      })

      if (stepDef.output) {
        context.set(stepDef.output, result?.output)
      } else if (result?.output && typeof result.output === 'object' && !Array.isArray(result.output)) {
        context.merge(result.output)
      }

      updateStepRun(stepRunId, {
        status: 'done',
        output: result?.output,
        durationMs: Date.now() - started,
        tokenUsed: result?.usage?.total_tokens,
        finishedAt: Date.now()
      })

      updateRunStatus(runId, 'running', { context: context.toJSON() })
      return result
    } catch (err) {
      updateStepRun(stepRunId, {
        status: 'failed',
        error: err.message,
        durationMs: Date.now() - started,
        finishedAt: Date.now()
      })
      throw err
    } finally {
      // 恢复父步骤的 _currentStepIndex，避免子步骤执行时覆盖父步骤状态
      context.set('_currentStepIndex', prevCurrentStepIndex)
    }
  }

  async executeWithTimeout(step, context, stepDef) {
    const timeoutMs = stepDef.timeout || step.timeout || 30000
    return Promise.race([
      step.execute(context, stepDef),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Step timeout after ${timeoutMs}ms`)), timeoutMs))
    ])
  }

  async recoverRuns() {
    const recoverable = getRecoverableRuns()
    if (!recoverable.length) return

    logger.info({ count: recoverable.length }, 'Recovering workflow runs')

    for (const run of recoverable) {
      const workflow = this.workflows.find(flow => flow.id === run.workflow_id)
      if (!workflow) continue

      const contextData = run.context_json ? JSON.parse(run.context_json) : {}
      const context = new WorkflowContext({ ...contextData, _runId: run.id })
      const completed = getCompletedStepRuns(run.id)

      // 恢复 conversation，避免恢复执行时丢失多轮历史
      const event = context.get('event', {})
      const conversation = getOrCreateConversation({
        source: event.source || 'openclaw',
        channelId: event.channelId || context.get('channelId'),
        userId: event.userId || context.get('userId')
      })

      // 用顶层 step_index 的最大值 +1 来确定恢复位点，避免 conditional/parallel 子 step 混算
      // 顶层 step 的 step_index 对应 workflow.steps 数组下标（0-based）
      const topLevelCompleted = completed.filter(s => s.step_index >= 0 && s.step_index < workflow.steps.length)
      const maxCompletedIndex = topLevelCompleted.reduce((max, s) => Math.max(max, s.step_index), -1)
      const nextIndex = maxCompletedIndex + 1

      if (run.status !== 'running') assertTransition(run.status, 'running')
      updateRunStatus(run.id, 'running', { context: context.toJSON() })

      try {
        for (let i = nextIndex; i < workflow.steps.length; i++) {
          await this.runStep({
            stepDef: workflow.steps[i],
            stepIndex: i,
            context,
            runId: run.id,
            conversation,
            workflow
          })
        }

        const doneRun = getRunById(run.id)
        assertTransition(doneRun ? doneRun.status : 'running', 'done')
        updateRunStatus(run.id, 'done', {
          finishedAt: Date.now(),
          context: context.toJSON()
        })
      } catch (err) {
        const failRun = getRunById(run.id)
        assertTransition(failRun ? failRun.status : 'running', 'failed')
        updateRunStatus(run.id, 'failed', {
          finishedAt: Date.now(),
          error: err.message,
          context: context.toJSON()
        })
      }
    }
  }

  async _handleOnError({ workflow, context, runId, err }) {
    if (workflow.onError !== 'notify-and-dlq') return

    const channelId = context.get('channelId')
    if (!channelId) return

    const content = `⚠️ 工作流执行失败\n流程：${workflow.name || workflow.id}\nrunId：${runId}\n原因：${err.message}`
    const msgId = enqueueMessage({ runId, channelId, content })
    outboxEmitter.emit('new_message', { msgId, runId })
  }
}

function loadConversationHistory(conversation) {
  if (!conversation?.context_json) return []
  try {
    const parsed = JSON.parse(conversation.context_json)
    if (Array.isArray(parsed?.history)) return parsed.history
    return []
  } catch (_) {
    return []
  }
}

function buildConversationSummary(context) {
  const input = context.get('input', '')
  const topic = context.get('topic', '')
  const article = context.get('article', '')
  return {
    ts: Date.now(),
    userInput: input,
    topic,
    articlePreview: typeof article === 'string' ? article.slice(0, 200) : ''
  }
}

/**
 * 收集 step 需要的 context key（来源：step.requires + stepDef.requires + stepDef.dependsOn）
 */
function collectRequiredKeys(step, stepDef) {
  const keys = new Set()
  const fromStep = Array.isArray(step.requires) ? step.requires : []
  const fromDef = Array.isArray(stepDef.requires) ? stepDef.requires
    : Array.isArray(stepDef.dependsOn) ? stepDef.dependsOn : []
  for (const k of [...fromStep, ...fromDef]) keys.add(k)
  return [...keys]
}

/**
 * 校验 context 中是否存在所有必需的 key
 * 缺失时抛出带详细信息的错误（retryable=false，直接进 DLQ）
 */
function assertRequiredContextKeys(context, keys, { stepName, stepIndex, workflowId } = {}) {
  if (!keys.length) return
  const missing = keys.filter(k => !context.has(k))
  if (missing.length) {
    const err = new Error(
      `Step [${stepName}] (index=${stepIndex}, workflow=${workflowId}) missing required context key(s): ${missing.join(', ')}`
    )
    err.isInputError = true    // 标记为输入缺失，不重试
    err.notRetryable = true
    throw err
  }
}

module.exports = WorkflowEngine

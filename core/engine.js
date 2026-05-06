'use strict'

const WorkflowContext = require('./context')
const { dispatchSteps } = require('./dispatcher')
const { assertTransition } = require('./state-machine')
const { withRetry } = require('./retry')
const { createRun, updateRunStatus, getRecoverableRuns, getRunById, getWaitingRunByChannel } = require('../persist/repos/workflow.repo')
const { createStepRun, updateStepRun, getCompletedStepRuns } = require('../persist/repos/step.repo')
const { markProcessing, markDone, markFailed } = require('../persist/repos/event.repo')
const { updateConversation, getOrCreateConversation } = require('../persist/repos/conversation.repo')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('../trigger/outbox-worker')
const { buildStep } = require('../steps')
const logger = require('../utils/logger')

// ==================== 拦截器 ====================
// 白名单逻辑：复用已注册 workflow 的 trigger.match，
// 只要消息能匹配任意一个流程的触发条件，就放行进入引擎。
// 时间过滤和用户白名单暂不启用，未来按需在此扩展。
function buildInterceptor(workflows) {
  return function shouldProcessMessage(event) {
    const { text, userId, channelId } = event
    const matched = workflows.some(flow => {
      if (!flow.trigger) return false
      if (flow.trigger.type && flow.trigger.type !== event.triggerType) return false
      if (flow.trigger.match instanceof RegExp) return flow.trigger.match.test(text || '')
      return false
    })

    if (!matched) {
      logger.info({ channelId, userId, text: text?.slice(0, 30) }, '⏭️ 拦截：不匹配任何流程触发条件，交还 openclaw')
      return { allowed: false, reason: 'no_workflow_match' }
    }

    return { allowed: true }
  }
}

class WorkflowEngine {
  constructor({ workflows }) {
    this.workflows = workflows || []
    this.shouldProcessMessage = buildInterceptor(this.workflows)
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
    // 拦截器：复用 workflow trigger.match 做前置判断，不匹配任何流程则交还 openclaw
    const interceptResult = this.shouldProcessMessage(event)
    if (!interceptResult.allowed) {
      logger.info({ inboxEventId, channelId: event.channelId, reason: interceptResult.reason }, '🚫 消息被拦截，跳过流程匹配')
      if (inboxEventId) markDone(inboxEventId)
      return null
    }

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
    const workflowConfig = normalizeWorkflowConfig(workflow?.config)
    const initialContext = {
      _runId: runId,
      _config: workflowConfig,
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
      const currentStatus = currentRun ? currentRun.status : 'running'

      // 如果是等待用户输入状态，不转换到 done
      if (currentStatus === 'waiting') {
        if (eventId) markDone(eventId)
        return
      }

      assertTransition(currentStatus, 'done')
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

      // 检查是否需要等待用户输入
      if (result && result._wait) {
        updateStepRun(stepRunId, {
          status: 'done',
          output: result.output,
          durationMs: Date.now() - started,
          finishedAt: Date.now()
        })
        // 标记 run 为 waiting，保存当前 step index
        updateRunStatus(runId, 'waiting', {
          context: { ...context.toJSON(), _waitStepIndex: stepIndex, _waitStepName: stepName }
        })
        logger.info({ runId, stepName, stepIndex }, '⏸️ Workflow paused, waiting for user input')
        return result
      }

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
      err.stepName = stepName
      throw err
    } finally {
      // 恢复父步骤的 _currentStepIndex，避免子步骤执行时覆盖父步骤状态
      context.set('_currentStepIndex', prevCurrentStepIndex)
    }
  }

  async executeWithTimeout(step, context, stepDef) {
    const timeoutMs = stepDef.timeout || step.timeout || 30000
    const runId = context.get('_runId')
    logger.debug({ runId, stepName: step.name, timeoutMs }, 'Step executing (timeout set)')
    return Promise.race([
      step.execute(context, stepDef),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Step timeout after ${timeoutMs}ms`)),
        timeoutMs
      ))
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
      const workflowConfig = normalizeWorkflowConfig(workflow?.config)
      const context = new WorkflowContext({ ...contextData, _runId: run.id, _config: workflowConfig })
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

    const stepInfo = err.stepName ? `\n失败步骤：${err.stepName}` : ''
    const content = `⚠️ 工作流执行失败\n流程：${workflow.name || workflow.id}\nrunId：${runId}${stepInfo}\n原因：${err.message}`
    const msgId = enqueueMessage({ runId, channelId, content })
    outboxEmitter.emit('new_message', { msgId, runId })
  }

  /**
   * 恢复等待中的 workflow run
   * @param {string} channelId - 频道 ID
   * @param {string} userInput - 用户输入的文本
   * @returns {string|null} - runId 或 null
   */
  async resumeRun(channelId, userInput) {
    const waitingRun = getWaitingRunByChannel(channelId)
    if (!waitingRun) return null

    const workflow = this.workflows.find(flow => flow.id === waitingRun.workflow_id)
    if (!workflow) {
      logger.error({ runId: waitingRun.id, workflowId: waitingRun.workflow_id }, 'Cannot resume: workflow not found')
      updateRunStatus(waitingRun.id, 'failed', { error: 'Workflow not found for resume' })
      return null
    }

    const contextData = waitingRun.context_json ? JSON.parse(waitingRun.context_json) : {}
    const workflowConfig = normalizeWorkflowConfig(workflow?.config)
    const context = new WorkflowContext({ ...contextData, _runId: waitingRun.id, _config: workflowConfig })

    // 注入用户回复
    context.set('userReply', userInput)
    context.set('input', userInput)

    // 从等待的下一步继续
    const waitStepIndex = contextData._waitStepIndex ?? 0
    const nextIndex = waitStepIndex + 1

    // 加载 conversation
    const conversation = getOrCreateConversation({
      source: 'openclaw',
      channelId,
      userId: context.get('userId')
    })

    logger.info({ runId: waitingRun.id, channelId, nextIndex, userInput: userInput.slice(0, 50) }, '▶️ Resuming workflow from wait')

    updateRunStatus(waitingRun.id, 'running', { context: context.toJSON() })

    try {
      for (let i = nextIndex; i < workflow.steps.length; i++) {
        await this.runStep({
          stepDef: workflow.steps[i],
          stepIndex: i,
          context,
          runId: waitingRun.id,
          conversation,
          workflow
        })
      }

      const doneRun = getRunById(waitingRun.id)
      if (doneRun && doneRun.status === 'running') {
        updateRunStatus(waitingRun.id, 'done', {
          finishedAt: Date.now(),
          context: context.toJSON()
        })
      }

      if (conversation?.id) {
        const summary = buildConversationSummary(context)
        const prevHistory = loadConversationHistory(conversation)
        const updatedHistory = [...prevHistory, summary].slice(-10)
        updateConversation(conversation.id, {
          lastRunId: waitingRun.id,
          context: { history: updatedHistory }
        })
      }

      return waitingRun.id
    } catch (err) {
      logger.error({ runId: waitingRun.id, err: err.message }, 'Workflow resume failed')
      updateRunStatus(waitingRun.id, 'failed', {
        finishedAt: Date.now(),
        error: err.message,
        context: context.toJSON()
      })

      if (workflow?.onError) {
        await this._handleOnError({ workflow, context, runId: waitingRun.id, err })
      }

      return null
    }
  }
}

/**
 * 将 workflow.config 标准化为纯对象，注入 context._config
 * 若未定义则返回空对象，保证 step 内 context.get('_config') 始终可用
 */
function normalizeWorkflowConfig(config) {
  if (config && typeof config === 'object' && !Array.isArray(config)) return { ...config }
  return {}
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

module.exports = { WorkflowEngine, buildInterceptor }

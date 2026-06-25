'use strict'

const { describe, it, expect, beforeEach, jest: jestGlobal } = require('@jest/globals')

// Mock all persistence repos
jest.mock('../../persist/repos/workflow.repo', () => ({
  createRun: jest.fn(() => 'run_1'),
  updateRunStatus: jest.fn(),
  getRunById: jest.fn(),
  getRecoverableRuns: jest.fn(() => []),
  getWaitingRunByChannel: jest.fn(),
  getAllWaitingRunsByChannel: jest.fn(() => []),
  cancelWaitingRun: jest.fn(() => true)
}))

jest.mock('../../persist/repos/step.repo', () => ({
  createStepRun: jest.fn(() => 'step_1'),
  updateStepRun: jest.fn(),
  getCompletedStepRuns: jest.fn(() => [])
}))

jest.mock('../../persist/repos/event.repo', () => ({
  markProcessing: jest.fn(),
  markDone: jest.fn(),
  markFailed: jest.fn()
}))

jest.mock('../../persist/repos/conversation.repo', () => ({
  updateConversation: jest.fn(),
  getOrCreateConversation: jest.fn(() => ({ id: 'conv_1' }))
}))

jest.mock('../../persist/repos/outbox.repo', () => ({
  enqueue: jest.fn(() => 'msg_1')
}))

jest.mock('../../trigger/outbox-worker', () => ({
  outboxEmitter: { emit: jest.fn() }
}))

const { WorkflowEngine, buildInterceptor } = require('../../core/engine')
const { createRun, updateRunStatus, getRunById } = require('../../persist/repos/workflow.repo')
const { markDone, markProcessing } = require('../../persist/repos/event.repo')

describe('WorkflowEngine', () => {
  let engine

  beforeEach(() => {
    jest.clearAllMocks()
    engine = new WorkflowEngine({ workflows: [] })
  })

  describe('buildInterceptor', () => {
    it('should return allowed=true when message matches workflow trigger', () => {
      const workflows = [{
        id: 'test',
        trigger: { type: 'message', match: /hello/ }
      }]
      const interceptor = buildInterceptor(workflows)
      const result = interceptor({ text: 'hello world', triggerType: 'message' })
      expect(result.allowed).toBe(true)
    })

    it('should return allowed=false when message does not match', () => {
      const workflows = [{
        id: 'test',
        trigger: { type: 'message', match: /^特定关键词/ }
      }]
      const interceptor = buildInterceptor(workflows)
      const result = interceptor({ text: '普通消息', triggerType: 'message' })
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('no_workflow_match')
    })

    it('should skip disabled workflows', () => {
      const workflows = [{
        id: 'test',
        enabled: false,
        trigger: { type: 'message', match: /.*/ }
      }]
      const interceptor = buildInterceptor(workflows)
      const result = interceptor({ text: 'anything', triggerType: 'message' })
      expect(result.allowed).toBe(false)
    })

    it('should match when at least one workflow matches', () => {
      const workflows = [
        { id: 'a', trigger: { type: 'message', match: /nope/ } },
        { id: 'b', trigger: { type: 'message', match: /yes/ } }
      ]
      const interceptor = buildInterceptor(workflows)
      const result = interceptor({ text: 'yes please', triggerType: 'message' })
      expect(result.allowed).toBe(true)
    })
  })

  describe('matchWorkflow', () => {
    it('should return matching workflow', () => {
      const workflows = [
        { id: 'a', trigger: { type: 'message', match: /alpha/ } },
        { id: 'b', trigger: { type: 'message', match: /beta/ } }
      ]
      engine = new WorkflowEngine({ workflows })
      const result = engine.matchWorkflow({ text: 'beta test', triggerType: 'message' })
      expect(result.id).toBe('b')
    })

    it('should return undefined when no match', () => {
      engine = new WorkflowEngine({
        workflows: [{ id: 'a', trigger: { type: 'message', match: /^exact$/ } }]
      })
      const result = engine.matchWorkflow({ text: 'no match', triggerType: 'message' })
      expect(result).toBeUndefined()
    })

    it('should skip disabled workflows', () => {
      engine = new WorkflowEngine({
        workflows: [{ id: 'a', enabled: false, trigger: { type: 'message', match: /.*/ } }]
      })
      const result = engine.matchWorkflow({ text: 'anything', triggerType: 'message' })
      expect(result).toBeUndefined()
    })
  })

  describe('handleEvent', () => {
    it('should return null when interceptor blocks', async () => {
      engine = new WorkflowEngine({
        workflows: [{ id: 'a', trigger: { type: 'message', match: /^specific$/ } }]
      })
      const result = await engine.handleEvent({
        event: { text: 'not matching', channelId: 'ch1', triggerType: 'message' },
        conversation: { id: 'conv1' },
        inboxEventId: 'evt1'
      })
      expect(result).toBeNull()
      expect(markDone).toHaveBeenCalledWith('evt1')
    })

    it('should create run when workflow matches and has steps', async () => {
      const mockStep = { type: 'noop' }
      engine = new WorkflowEngine({
        workflows: [{ id: 'a', trigger: { type: 'message', match: /aaa/ }, steps: [mockStep] }]
      })
      // Mock runWorkflow to avoid executing real steps
      engine.runWorkflow = jest.fn()
      const result = await engine.handleEvent({
        event: { text: 'aaa', channelId: 'ch1', triggerType: 'message' },
        conversation: null,
        inboxEventId: 'evt1'
      })
      expect(result).toBe('run_1')
      expect(engine.runWorkflow).toHaveBeenCalled()
    })
  })

  describe('cancelRun', () => {
    it('should delegate to cancelWaitingRun', () => {
      const result = engine.cancelRun('run_1')
      expect(result).toBe(true)
    })
  })

  describe('getWaitingRuns', () => {
    it('should return empty array when no waiting runs', () => {
      const runs = engine.getWaitingRuns('ch1')
      expect(runs).toEqual([])
    })

    it('should parse context and return structured data', () => {
      const mockRun = {
        id: 'run_1',
        workflow_id: 'flow_1',
        context_json: JSON.stringify({
          _waitStepName: 'select-topic',
          _waitType: 'user_input',
          _pauseReason: 'waiting for user'
        }),
        created_at: '2025-01-01'
      }
      require('../../persist/repos/workflow.repo').getAllWaitingRunsByChannel.mockReturnValue([mockRun])

      const runs = engine.getWaitingRuns('ch1')
      expect(runs).toHaveLength(1)
      expect(runs[0].runId).toBe('run_1')
      expect(runs[0].stepName).toBe('select-topic')
      expect(runs[0].waitType).toBe('user_input')
    })
  })
})

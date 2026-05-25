'use strict'

const { describe, it, expect } = require('@jest/globals')
const BaseStep = require('../../steps/base.step')

describe('BaseStep', () => {
  it('should throw on name getter', () => {
    const step = new BaseStep()
    expect(() => step.name).toThrow('Step must implement get name()')
  })

  it('should have default description', () => {
    const step = new BaseStep()
    expect(step.description).toBe('未声明 Step 功能描述')
  })

  it('should have default category', () => {
    const step = new BaseStep()
    expect(step.category).toBe('uncategorized')
  })

  it('should be retryable by default', () => {
    const step = new BaseStep()
    expect(step.retryable).toBe(true)
  })

  it('should have default timeout of 30s', () => {
    const step = new BaseStep()
    expect(step.timeout).toBe(30000)
  })

  it('should have empty requires by default', () => {
    const step = new BaseStep()
    expect(step.requires).toEqual([])
  })

  it('should have empty provides by default', () => {
    const step = new BaseStep()
    expect(step.provides).toEqual([])
  })

  it('should throw on execute', async () => {
    const step = new BaseStep()
    await expect(step.execute({}, {})).rejects.toThrow('Step must implement execute(context, stepDef)')
  })

  it('should convert kebab-case name to camelCase configKey', () => {
    const step = new (class extends BaseStep {
      get name() { return 'generate-topics' }
    })()
    expect(step._configKey).toBe('generateTopics')
  })

  it('should handle single word configKey', () => {
    const step = new (class extends BaseStep {
      get name() { return 'write' }
    })()
    expect(step._configKey).toBe('write')
  })
})

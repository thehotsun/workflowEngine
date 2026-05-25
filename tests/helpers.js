'use strict'

/**
 * Mock Context for testing steps
 * Simulates the workflow context object
 */
class MockContext {
  constructor(initialData = {}) {
    this._data = new Map(Object.entries(initialData))
    this._outputs = new Map()
  }

  get(key, defaultValue) {
    return this._data.has(key) ? this._data.get(key) : defaultValue
  }

  set(key, value) {
    this._data.set(key, value)
    return this
  }

  has(key) {
    return this._data.has(key)
  }

  getAll() {
    return Object.fromEntries(this._data)
  }

  // For testing: get all outputs set by steps
  getOutputs() {
    return Object.fromEntries(this._outputs)
  }
}

/**
 * Create a mock stepDef for testing
 */
function createStepDef(overrides = {}) {
  return {
    type: 'test-step',
    ...overrides
  }
}

/**
 * Create a mock config for testing
 */
function createConfig(overrides = {}) {
  return {
    accountProfile: {
      accountName: '测试公众号',
      authorCard: {
        badge: '测试标签',
        subtitle: '测试副标题',
        highlights: ['亮点1', '亮点2'],
        footer: '测试结尾'
      },
    },
    ...overrides
  }
}

module.exports = { MockContext, createStepDef, createConfig }

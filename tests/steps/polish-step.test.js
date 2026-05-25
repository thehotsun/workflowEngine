'use strict'

const { describe, it, expect } = require('@jest/globals')
const PolishStep = require('../../steps/polish.step')
const { MockContext } = require('../helpers')

describe('PolishStep', () => {
  const step = new PolishStep()

  it('should have correct metadata', () => {
    expect(step.name).toBe('polish')
    expect(step.description).toContain('润色')
    expect(step.category).toBe('content-creation')
    expect(step.timeout).toBe(60000)
    expect(step.requires).toContain('article')
    expect(step.provides).toContain('article')
  })
})

'use strict'

const { describe, it, expect } = require('@jest/globals')

describe('Logger', () => {
  it('should export a pino instance', () => {
    const logger = require('../../utils/logger')
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.debug).toBe('function')
  })
})

'use strict'

const { describe, it, expect, jest: jestGlobal } = require('@jest/globals')

// Mock DLQ repo before requiring retry
jest.mock('../../persist/repos/dlq.repo', () => ({
  enqueueDlq: jest.fn()
}))

const { withRetry } = require('../../core/retry')
const { enqueueDlq } = require('../../persist/repos/dlq.repo')

describe('withRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const result = await withRetry({ fn, stepName: 'test', runId: 'r1', maxRetries: 3, baseDelay: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should retry on failure and eventually succeed', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success')

    const result = await withRetry({ fn, stepName: 'test', runId: 'r1', maxRetries: 3, baseDelay: 1 })
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('should throw after maxRetries exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fail'))
    await expect(
      withRetry({ fn, stepName: 'test', runId: 'r1', maxRetries: 2, baseDelay: 1 })
    ).rejects.toThrow('always fail')
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('should enqueue to DLQ after retries exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'))
    try {
      await withRetry({ fn, stepName: 'myStep', runId: 'r1', maxRetries: 1, baseDelay: 1 })
    } catch (_) {}
    expect(enqueueDlq).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'r1',
      stepName: 'myStep',
      error: 'fail',
      retryCount: 2 // attempt 0 failed, attempt 1 failed, so count = 2
    }))
  })

  it('should not retry on notRetryable error', async () => {
    const err = new Error('input error')
    err.notRetryable = true
    const fn = jest.fn().mockRejectedValue(err)

    try {
      await withRetry({ fn, stepName: 'test', runId: 'r1', maxRetries: 3, baseDelay: 1 })
    } catch (_) {}
    expect(fn).toHaveBeenCalledTimes(1) // no retries
    expect(enqueueDlq).toHaveBeenCalled()
  })

  it('should not retry on isInputError', async () => {
    const err = new Error('missing input')
    err.isInputError = true
    const fn = jest.fn().mockRejectedValue(err)

    try {
      await withRetry({ fn, stepName: 'test', runId: 'r1', maxRetries: 3, baseDelay: 1 })
    } catch (_) {}
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should use exponential backoff delays', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('f1'))
      .mockRejectedValueOnce(new Error('f2'))
      .mockResolvedValue('ok')

    const start = Date.now()
    await withRetry({ fn, stepName: 'test', runId: 'r1', maxRetries: 3, baseDelay: 10 })
    const elapsed = Date.now() - start

    // First retry: 10 * 2^0 = 10ms, second retry: 10 * 2^1 = 20ms => ~30ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(20)
  })
})

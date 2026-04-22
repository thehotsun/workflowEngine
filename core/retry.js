'use strict'

const { enqueueDlq } = require('../persist/repos/dlq.repo')
const logger = require('../utils/logger')

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 1000

async function withRetry({ fn, stepName, runId, maxRetries = DEFAULT_MAX_RETRIES, baseDelay = DEFAULT_BASE_DELAY_MS }) {
  let attempt = 0
  let lastError

  while (attempt <= maxRetries) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      if (err?.notRetryable || err?.isInputError) {
        logger.warn({ runId, stepName, attempt, err: err.message }, 'Step failed with non-retryable error')
        break
      }

      attempt++
      if (attempt > maxRetries) {
        logger.error({ runId, stepName, attempt, maxRetries, err: err.message }, 'Step retries exhausted')
        break
      }

      const delay = baseDelay * Math.pow(2, attempt - 1)
      logger.warn({ runId, stepName, attempt, maxRetries, delayMs: delay, err: err.message }, 'Step failed, scheduling retry')
      await sleep(delay)
    }
  }

  enqueueDlq({ runId, stepName, error: lastError?.message || String(lastError), retryCount: attempt })
  throw lastError
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { withRetry }

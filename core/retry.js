'use strict'

const { enqueueDlq } = require('../persist/repos/dlq.repo')

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

      // 输入缺失/显式不可重试错误：直接失败，不做退避重试
      if (err?.notRetryable || err?.isInputError) {
        break
      }

      attempt++
      if (attempt > maxRetries) break
      // 指数退避
      const delay = baseDelay * Math.pow(2, attempt - 1)
      await sleep(delay)
    }
  }

  // 超过重试次数（或不可重试），写入死信队列
  enqueueDlq({ runId, stepName, error: lastError?.message || String(lastError), retryCount: attempt })
  throw lastError
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { withRetry }

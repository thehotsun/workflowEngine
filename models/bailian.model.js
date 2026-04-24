'use strict'

const OpenAI = require('openai')
const BaseModel = require('./base.model')
const {
  BAILIAN_API_KEY,
  BAILIAN_BASE_URL,
  BAILIAN_CHAT_MODEL,
  BAILIAN_EMBED_MODEL,
  MAX_CONCURRENT_EMBED_CALLS,
  MAX_CONCURRENT_LLM_CALLS
} = require('../config')
const logger = require('../utils/logger')

// 并发令牌池：控制 embedding 批并发
class Semaphore {
  constructor(max) {
    this.max = max
    this.count = 0
    this.queue = []
  }

  acquire() {
    return new Promise(resolve => {
      if (this.count < this.max) {
        this.count++
        resolve()
      } else {
        this.queue.push(resolve)
      }
    })
  }

  release() {
    this.count--
    if (this.queue.length > 0) {
      this.count++
      this.queue.shift()()
    }
  }
}

const LLM_SLOW_THRESHOLD_MS = 10_000
const EMBED_SLOW_THRESHOLD_MS = 5_000
const embedSemaphore = new Semaphore(MAX_CONCURRENT_EMBED_CALLS || 5)
const chatSemaphore = new Semaphore(MAX_CONCURRENT_LLM_CALLS || 3)

class BailianModel extends BaseModel {
  constructor() {
    super()
    if (!BAILIAN_API_KEY) {
      throw new Error('BAILIAN_API_KEY is not configured')
    }
    this.client = new OpenAI({
      apiKey: BAILIAN_API_KEY,
      baseURL: BAILIAN_BASE_URL
    })
  }

  get name() { return 'bailian' }

  async chat(messages, options = {}) {
    const startedAt = Date.now()
    const model = options.model || BAILIAN_CHAT_MODEL
    logger.debug({ model, msgCount: messages.length }, 'LLM chat start')
    await chatSemaphore.acquire()
    try {
      const response = await this.client.chat.completions.create({
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens
      })

      const content = response.choices?.[0]?.message?.content
      if (!content && content !== '') {
        throw new Error('Bailian chat: empty response from model')
      }

      const durationMs = Date.now() - startedAt
      const totalTokens = response.usage?.total_tokens
      if (durationMs >= LLM_SLOW_THRESHOLD_MS) {
        logger.warn({ model, durationMs, totalTokens }, 'LLM chat slow')
      } else {
        logger.debug({ model, durationMs, totalTokens }, 'LLM chat ok')
      }

      return {
        content: content || '',
        usage: response.usage || null
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      logger.error({ model, durationMs, err: err.message }, 'LLM chat failed')
      const wrapped = new Error(`BailianModel.chat failed: ${err.message}`)
      wrapped.cause = err
      wrapped.isModelError = true
      throw wrapped
    } finally {
      chatSemaphore.release()
    }
  }

  async embedding(text) {
    const startedAt = Date.now()
    await embedSemaphore.acquire()
    try {
      const response = await this.client.embeddings.create({
        model: BAILIAN_EMBED_MODEL,
        input: text
      })
      const durationMs = Date.now() - startedAt
      if (durationMs >= EMBED_SLOW_THRESHOLD_MS) {
        logger.warn({ durationMs }, 'Embedding request slow')
      }
      return response.data?.[0]?.embedding || []
    } catch (err) {
      const durationMs = Date.now() - startedAt
      logger.error({ durationMs, err: err.message }, 'Embedding request failed')
      const wrapped = new Error(`BailianModel.embedding failed: ${err.message}`)
      wrapped.cause = err
      wrapped.isModelError = true
      throw wrapped
    } finally {
      embedSemaphore.release()
    }
  }

  // 批量 embedding，每批最多 10 个，受并发令牌控制
  async embeddings(texts = []) {
    const BATCH_SIZE = 10
    const results = []

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE)
      const batchStartedAt = Date.now()
      const batchIndex = Math.floor(i / BATCH_SIZE)
      await embedSemaphore.acquire()
      try {
        const response = await this.client.embeddings.create({
          model: BAILIAN_EMBED_MODEL,
          input: batch
        })
        const batchResult = (response.data || []).map(item => item.embedding)
        results.push(...batchResult)
        const durationMs = Date.now() - batchStartedAt
        if (durationMs >= EMBED_SLOW_THRESHOLD_MS) {
          logger.warn({ batchIndex, batchSize: batch.length, durationMs }, 'Embeddings batch slow')
        }
      } catch (err) {
        const durationMs = Date.now() - batchStartedAt
        logger.error({ batchIndex, batchSize: batch.length, durationMs, err: err.message }, 'Embeddings batch failed, retrying one by one')
        const fallback = await this.embeddingBatchOneByOne(batch, i)
        results.push(...fallback)
      } finally {
        embedSemaphore.release()
      }
    }

    return results
  }
  async embeddingBatchOneByOne(texts = [], offset = 0) {
    const results = []
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]
      try {
        const response = await this.client.embeddings.create({
          model: BAILIAN_EMBED_MODEL,
          input: text
        })
        results.push(response.data?.[0]?.embedding || [])
      } catch (err) {
        const wrapped = new Error(`BailianModel.embeddings failed at chunk ${offset + i} (chars=${text?.length || 0}): ${err.message}`)
        wrapped.cause = err
        wrapped.isModelError = true
        throw wrapped
      }
    }
    return results
  }
}

module.exports = BailianModel

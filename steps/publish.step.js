'use strict'

const BaseStep = require('./base.step')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('../trigger/outbox-worker')

class PublishStep extends BaseStep {
  get name() { return 'publish' }
  get retryable() { return true }
  get timeout() { return 10_000 }
  get requires() { return ['article', 'channelId', '_runId'] }

  async execute(context) {
    const article = context.get('article')
    const channelId = context.get('channelId')
    const runId = context.get('_runId')

    if (!article) throw new Error('publish: no article in context')
    if (!channelId) throw new Error('publish: no channelId in context')
    if (!runId) throw new Error('publish: no _runId in context')

    // 仅写 outbox，由 outbox worker 负责真正发送，避免重复发送
    const msgId = enqueueMessage({ runId, channelId, content: article })

    // 事件驱动：通知 outbox worker 立即消费，降低发送延迟
    outboxEmitter.emit('new_message', { msgId, runId })

    return { ok: true, output: { published: false, queued: true, msgId } }
  }
}

module.exports = PublishStep

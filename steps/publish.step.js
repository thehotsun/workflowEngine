'use strict'

const BaseStep = require('./base.step')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('../trigger/outbox-worker')

/**
 * publish step — 将文章加入发布队列，等待异步发送
 * 
 * 工作方式：
 * 1. 将文章内容写入 outbox 数据库（避免重复发送）
 * 2. 通过事件驱动机制通知 worker 立即消费，降低发送延迟
 * 3. 实际发送由 outbox worker 异步处理
 * 
 * @workflow-config
 * - 无需配置
 * 
 * @requires ['article', 'channelId', '_runId'] - 文章内容、发布渠道、运行ID
 * @provides ['published', 'queued', 'msgId'] - 发布状态和消息ID
 */
class PublishStep extends BaseStep {
  get name() { return 'publish' }
  get description() { return '将文章写入 outbox 发布队列并触发即时发送，实际出站由 outbox worker 异步处理' }
  get category() { return 'output' }
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

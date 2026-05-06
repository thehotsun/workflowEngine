'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('../trigger/outbox-worker')
const logger = require('../utils/logger')

/**
 * select-topic step — 从候选话题中选择最合适的一个
 *
 * 流程：
 * 1. 生成候选话题列表
 * 2. 发送话题列表到用户 QQ，等待用户选择
 * 3. 返回 { _wait: true } 暂停 workflow
 * 4. 用户回复后，workflow 引擎自动恢复，从 context.userReply 中读取用户选择
 *
 * @workflow-config
 * - 无需配置，自动从context读取
 *
 * @requires ['topics', 'input'] - 候选话题列表和用户原始输入
 * @provides ['selectedTopic', 'topic'] - 选中的完整话题对象和话题标题
 */
class SelectTopicStep extends BaseStep {
  get name() { return 'select-topic' }
  get description() { return '发送候选话题给用户，等待用户选择后继续' }
  get category() { return 'content-creation' }
  get timeout() { return 300000 } // 5 分钟超时（等待用户回复）
  get requires() { return ['topics', 'input'] }
  get provides() { return ['selectedTopic', 'topic'] }

  async execute(context, stepDef) {
    const topics = context.get('topics', [])
    const input = context.get('input', '')
    const userReply = context.get('userReply', '')

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      throw new Error('select-topic: no topics available in context')
    }

    // 如果是恢复执行（用户已回复），直接解析选择
    if (userReply) {
      const selectedTopic = this._parseSelection(topics, userReply)
      logger.info({ userReply, selectedTopic: selectedTopic.title }, '✅ 用户已选择话题')
      return {
        ok: true,
        output: {
          selectedTopic,
          topic: selectedTopic.title
        }
      }
    }

    // 首次执行：发送话题列表给用户，等待选择
    const channelId = context.get('channelId')
    if (!channelId) {
      throw new Error('select-topic: channelId is required to send topic list')
    }

    const message = this._buildTopicMessage(topics, input)
    const runId = context.get('_runId')

    // 发送话题列表到用户
    const msgId = enqueueMessage({ runId, channelId, content: message })
    outboxEmitter.emit('new_message', { msgId, runId })

    logger.info({ channelId, topicCount: topics.length }, '📤 已发送候选话题，等待用户选择')

    // 返回 _wait 标记，通知引擎暂停
    return {
      ok: true,
      _wait: true,
      output: null
    }
  }

  /**
   * 解析用户选择
   */
  _parseSelection(topics, userReply) {
    const reply = userReply.trim()

    // 检查是否有直接引用 ID（如 T01, T02）
    for (const topic of topics) {
      if (topic.id && reply.toLowerCase().includes(topic.id.toLowerCase())) {
        return topic
      }
    }

    // 检查数字选择（如 "1", "2", "3"）
    const numMatch = reply.match(/^(\d+)$/)
    if (numMatch) {
      const index = parseInt(numMatch[1]) - 1
      if (index >= 0 && index < topics.length) {
        return topics[index]
      }
    }

    // 检查序数词（如 "第一个", "第二个"）
    const ordinalMatch = reply.match(/第[一二三四五六]个/)
    if (ordinalMatch) {
      const ordinalMap = { '第一': 0, '第二': 1, '第三': 2, '第四': 3, '第五': 4, '第六': 5 }
      const index = ordinalMap[ordinalMatch[0].slice(0, 2)]
      if (index !== undefined && topics[index]) {
        return topics[index]
      }
    }

    // 尝试用模型解析
    // fallback: 默认选第一个
    logger.warn({ userReply }, '⚠️ 无法解析用户选择，默认选第一个')
    return topics[0]
  }

  /**
   * 构建话题选择消息
   */
  _buildTopicMessage(topics, userInput) {
    let msg = '📝 为你生成了以下候选话题，请选择：\n\n'

    topics.forEach((topic, i) => {
      const id = topic.id || `T${i + 1}`
      const title = topic.title || '未命名话题'
      const intro = topic.intro || ''
      msg += `${id}. ${title}\n`
      if (intro) {
        msg += `   ${intro}\n`
      }
      msg += '\n'
    })

    msg += '────────────\n'
    msg += '请回复话题编号（如 T01 或 1）或直接输入标题关键词：'

    return msg
  }
}

module.exports = SelectTopicStep

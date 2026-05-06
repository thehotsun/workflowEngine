'use strict'

const BaseStep = require('./base.step')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('../trigger/outbox-worker')
const logger = require('../utils/logger')

/**
 * select-topic step — 从候选话题中选择最合适的一个
 *
 * 两阶段交互流程：
 *
 * 【阶段一：首次执行】
 *   - 将候选话题列表发送给用户
 *   - 返回 { _wait: true } 通知引擎暂停，run 状态变为 waiting
 *
 * 【阶段二：恢复执行】
 *   - 用户回复后，引擎调用 resumeRun()，注入 context.userReply
 *   - 引擎从本步骤（waitStepIndex）重新执行，此时 userReply 已存在
 *   - 解析用户选择，写入 selectedTopic / topic，后续步骤正常继续
 *
 * 用户回复解析优先级：
 *   1. T01 / T02 等 ID 精确匹配
 *   2. 纯数字（1、2、3）
 *   3. 序数词（第一个、第二个）
 *   4. 标题关键词模糊匹配
 *   5. fallback：默认选第一个并给出提示
 *
 * @workflow-config
 * - 无需配置，自动从 context 读取
 *
 * @requires ['topics', 'input'] - 候选话题列表和用户原始输入
 * @provides ['selectedTopic', 'topic'] - 选中的完整话题对象和话题标题
 */
class SelectTopicStep extends BaseStep {
  get name() { return 'select-topic' }
  get description() { return '发送候选话题给用户，等待用户选择后继续' }
  get category() { return 'content-creation' }
  get timeout() { return 30000 }
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

    // 标题关键词模糊匹配：统计 reply 中有多少个汉字/字母出现在标题里
    // 至少命中 2 个字才采信，防止单字母/标点误判
    const replyLower = reply.toLowerCase()
    let bestMatch = null
    let bestScore = 0
    for (const topic of topics) {
      const titleLower = (topic.title || '').toLowerCase()
      let score = 0
      for (const ch of replyLower) {
        // 只统计非空白字符
        if (ch.trim() && titleLower.includes(ch)) score++
      }
      if (score > bestScore) {
        bestScore = score
        bestMatch = topic
      }
    }
    if (bestMatch && bestScore >= 2) {
      logger.info({ userReply, matchedTitle: bestMatch.title, score: bestScore }, '🔍 标题关键词匹配成功')
      return bestMatch
    }

    // fallback: 无法解析，默认选第一个
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
    msg += '请回复话题编号（如 T01、T02 或 1、2），也可以直接输入标题里的关键词：'

    return msg
  }
}

module.exports = SelectTopicStep

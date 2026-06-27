'use strict'

const BaseStep = require('../base.step')
const { enqueueMessage } = require('../../persist/repos/outbox.repo')
const { outboxEmitter } = require('../../trigger/outbox-worker')
const logger = require('../../utils/logger')

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
 *   4. fallback：默认选第一个并给出提示
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

    // 如果是恢复执行（用户已回复），解析选择
    if (userReply) {
      const selectedTopic = this._parseSelection(topics, userReply)

      // 解析失败（不是纯数字），发提醒继续等待
      if (!selectedTopic) {
        const channelId = context.get('channelId')
        const reminderMsg = '⚠️ 请回复话题编号（纯数字），如回复 1 或 2'
        if (channelId) {
          const runId = context.get('_runId')
          const msgId = enqueueMessage({ runId, channelId, content: reminderMsg })
          outboxEmitter.emit('new_message', { msgId, runId })
        }
        logger.info({ userReply }, '⚠️ 用户回复无效，发送提醒继续等待')
        return {
          ok: true,
          _wait: true,
          output: null
        }
      }

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
   * 解析用户选择 — 只接受纯阿拉伯数字（1、2、3、4、5、6）
   * 其他任何内容一律返回 null，继续等待
   */
  _parseSelection(topics, userReply) {
    const reply = userReply.trim()

    // 只匹配纯数字
    const numMatch = reply.match(/^(\d+)$/)
    if (numMatch) {
      const index = parseInt(numMatch[1]) - 1
      if (index >= 0 && index < topics.length) {
        return topics[index]
      }
    }

    // 不是纯数字或数字超出范围，返回 null 表示无效
    logger.warn({ userReply }, '⚠️ 用户回复不是有效数字，继续等待')
    return null
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
    msg += '请回复数字选择（如 1、2）：'

    return msg
  }
}

module.exports = SelectTopicStep

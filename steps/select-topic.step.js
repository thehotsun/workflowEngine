'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

/**
 * select-topic step — 从候选话题中选择最合适的一个
 * 
 * 支持多种选择方式：
 * 1. 自动识别用户输入中的话题ID（如"选T01"、"我要第二个"）
 * 2. 通过模型根据用户需求智能选择最佳话题
 * 3. 按分数排序选择最高分的话题（fallback）
 * 
 * @workflow-config
 * - 无需配置，自动从context读取
 * 
 * @requires ['topics', 'input'] - 候选话题列表和用户原始输入
 * @provides ['selectedTopic', 'topic'] - 选中的完整话题对象和话题标题
 */
class SelectTopicStep extends BaseStep {
  get name() { return 'select-topic' }
  get description() { return '从候选话题中选择一个最合适的话题（支持用户显式选择、模型选择和评分回退）' }
  get category() { return 'content-creation' }
  get timeout() { return 30000 }
  get requires() { return ['topics', 'input'] }
  get provides() { return ['selectedTopic', 'topic'] }

  async execute(context, stepDef) {
    const topics = context.get('topics', [])
    const input = context.get('input', '')

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      throw new Error('select-topic: no topics available in context')
    }

    // 首先检查用户是否在 input 中直接选择了某个 topic（例如：选 T01 或我要写第二个）
    let selectedTopic = this._tryAutoSelect(topics, input)

    if (!selectedTopic) {
      // 如果没有直接选择，让模型根据用户输入选择最合适的话题
      selectedTopic = await this._selectWithModel(topics, input)
    }

    // 将 selectedTopic 同时设置为 topic，供后续 step 使用
    return {
      ok: true,
      output: {
        selectedTopic,
        topic: selectedTopic.title
      }
    }
  }

  _tryAutoSelect(topics, input) {
    const inputLower = input.toLowerCase()

    // 检查是否有直接引用 ID 的（如 T01, T02 等）
    for (const topic of topics) {
      if (topic.id && inputLower.includes(topic.id.toLowerCase())) {
        return topic
      }
    }

    // 检查是否有"第一个"、"第二个"等序数词
    const ordinalMatch = input.match(/第[一二三四五六]个/)
    if (ordinalMatch) {
      const ordinalMap = { '第一': 0, '第二': 1, '第三': 2, '第四': 3, '第五': 4, '第六': 5 }
      const index = ordinalMap[ordinalMatch[0].slice(0, 2)]
      if (index !== undefined && topics[index]) {
        return topics[index]
      }
    }

    // 检查是否选择分数最高的
    const sortedByScore = [...topics].sort((a, b) => (b.score || 0) - (a.score || 0))
    if (sortedByScore.length > 0) {
      return sortedByScore[0]
    }

    return null
  }

  async _selectWithModel(topics, input) {
    const topicsText = topics
      .map((t, i) => `${t.id || `T${i + 1}`}. ${t.title}\n   ${t.intro}`)
      .join('\n\n')

    const systemPrompt = `你是一位资深公众号编辑。请根据用户的需求，从以下候选话题中选择最合适的一个。
只输出选中话题的 ID（如 T01），不要输出其他内容。`

    const userPrompt = `用户需求：${input}\n\n候选话题：\n${topicsText}\n\n请选择最合适的话题 ID：`

    const model = modelRouter.route('analysis')
    const { content } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ])

    // 尝试从模型输出中提取 topic ID
    const match = content.trim().match(/T\d+/)
    if (match) {
      const found = topics.find(t => t.id === match[0])
      if (found) return found
    }

    // 如果找不到匹配的 ID，返回第一个话题作为 fallback
    return topics[0]
  }
}

module.exports = SelectTopicStep

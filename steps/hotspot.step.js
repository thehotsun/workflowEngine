'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

/**
 * hotspot step — 从搜索结果和知识库中发现热点话题
 * 
 * 主要功能：
 * 1. 分析最新搜索资讯和知识库内容
 * 2. 提炼当前最值得关注的热点话题（1-3个）
 * 3. 为每个话题给出适合公众号传播的切入角度
 * 4. 如果没有搜索/知识库数据，仅凭用户输入生成建议
 * 
 * @workflow-config
 * - 无需配置，自动从context读取
 * 
 * @requires ['input'] - 用户原始需求（可选，用于 fallback）
 * @provides ['hotspot', 'hotspotSuggestions'] - 热点话题和切入建议
 */
class HotspotStep extends BaseStep {
  get name() { return 'hotspot' }
  get description() { return '从搜索结果或知识库中提炼热点话题与传播角度（LLM），已有实时热点时请用 fetch-hotspots 代替' }
  get category() { return 'content-creation' }
  get timeout() { return 30_000 }
  get provides() { return ['hotspot', 'hotspotSuggestions'] }

  async execute(context) {
    const input = context.get('input', '')
    const searchResults = context.get('searchResults', [])
    const ragResults = context.get('ragResults', [])

    const searchCtx = Array.isArray(searchResults)
      ? searchResults.slice(0, 5).map(r => r.content || r.snippet || r.title || '').filter(Boolean).join('\n')
      : ''

    const ragCtx = Array.isArray(ragResults)
      ? ragResults.slice(0, 3).map(r => `${r.heading ? `[${r.heading}] ` : ''}${r.content}`).filter(Boolean).join('\n')
      : ''

    const systemPrompt = [
      '你是一位资深内容策划，擅长从海量信息中快速识别热点话题和传播角度。',
      '请分析下方信息，提炼出：',
      '1. 最值得关注的热点话题（1~3 个，每个不超过 20 字）',
      '2. 针对每个话题，给出一个适合公众号或群内传播的内容切入角度（一句话）',
      '输出格式为 JSON，示例：',
      '{"hotspot":"XXX热点","suggestions":["角度1","角度2"]}'
    ].join('\n')

    const userLines = [`用户需求：${input}`]
    if (searchCtx) userLines.push(`\n最新搜索资讯：\n${searchCtx}`)
    if (ragCtx) userLines.push(`\n知识库参考：\n${ragCtx}`)
    userLines.push('\n请按 JSON 格式输出。')

    const model = modelRouter.route('analysis')
    const { content, usage } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userLines.join('\n') }
    ])

    let hotspot = ''
    let suggestions = []

    try {
      // 模型可能在 JSON 外包一层 markdown fence
      const jsonStr = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(jsonStr)
      hotspot = parsed.hotspot || ''
      suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    } catch {
      // 解析失败时把整段输出作为 hotspot 文本
      hotspot = content.trim()
    }

    return {
      ok: true,
      output: { hotspot, hotspotSuggestions: suggestions },
      usage
    }
  }
}

module.exports = HotspotStep

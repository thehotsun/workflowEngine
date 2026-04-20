'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

/**
 * HotspotStep — 热点话题发现
 *
 * 从 context 中读取 searchResults（由 skill-proxy web-search 写入），
 * 结合可选的 ragResults，让模型提炼出当前热点话题与角度建议，
 * 写入 context.hotspot（字符串）和 context.hotspotSuggestions（数组）。
 *
 * 如果 searchResults / ragResults 都不存在，则仅凭用户原始输入生成建议。
 */
class HotspotStep extends BaseStep {
  get name() { return 'hotspot' }
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

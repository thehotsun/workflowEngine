'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')
const openclawClient = require('../openclaw/client')
const logger = require('../utils/logger')

/**
 * research step — 对选定话题进行深入研究，为写作做准备
 *
 * 结合知识库检索结果、最新搜索资讯，输出：
 * 1. articleAngle - 文章切入角度
 * 2. keyFacts - 关键事实点
 * 3. styleCues - 写法提示
 * 4. outline - 文章大纲
 * 5. riskNotes - 风险提示（健康、政策类）
 * 6. imageDirections - 配图方向建议
 *
 * 改进：
 * - 搜索词优化：用 LLM 提取关键词再搜索
 * - 多轮搜索：从案例+数据、报告+调研两个角度搜
 * - 结果过滤：按核心词匹配过滤无关结果
 * - 防编造：要求 keyFacts 必须引用搜索素材，无素材时注明
 *
 * @workflow-config
 * - _config.research.model.taskType: LLM 路由 taskType（默认 'analysis'）
 * - _config.research.temperature: LLM 温度（默认 0.7）
 * - _config.research.maxTokens: 最大 token（默认 2000）
 * - _config.research.persona: 编辑人设（string）
 * - _config.research.styleGuide: 风格指南（object，含 angle/facts/structure/cues/taboos）
 *
 * @requires ['selectedTopic'] - 已选定的话题
 * @provides ['research'] - 完整的研究结果对象
 */
class ResearchStep extends BaseStep {
  get name() { return 'research' }
  get description() { return '围绕已选话题做写作前研究，输出角度、事实点、大纲、风险提示等结构化结果（LLM）' }
  get category() { return 'content-creation' }
  get timeout() { return 80000 }
  get requires() { return ['selectedTopic'] }
  get provides() { return ['research'] }

  async execute(context) {
    const selectedTopic = context.get('selectedTopic')
    const ragResults = context.get('ragResults', [])
    let searchResults = context.get('searchResults', [])
    const styleBrief = context.get('styleBrief', [])

    logger.info({ topic: selectedTopic?.title?.slice(0, 30) }, '🔬 research: 开始研究')

    const config = context.get('_config') || {}
    const stepConfig = config[this._configKey] || {}

    // ===== 改进①：提取搜索关键词 + 改进②：多轮搜索 + 改进③：过滤 =====
    if (!searchResults || searchResults.length === 0) {
      try {
        const keywords = await this._extractKeywords(selectedTopic)
        logger.info({ keywords }, '🔬 research: 提取关键词完成')

        // 拆分关键词，用更宽的词搜索
        const kwList = keywords.split(/\s+/).filter(w => w.length >= 2)
        const queries = [
          kwList.slice(0, 2).join(' ') + ' 老年人 真实案例',
          kwList.slice(0, 2).join(' ') + ' 新闻 报道',
          kwList.slice(0, 3).join(' ') + ' 调查报告 数据'
        ]

        const allResults = []
        for (const query of queries) {
          try {
            logger.info({ query }, '🔬 research: 搜索中')
            const searchRes = await openclawClient.invokeTool('web_search', {
              query,
              count: 5
            }, { action: 'search', timeoutMs: 15000 })
            let results = []
            try {
              const textBlock = searchRes?.result?.content?.find(c => c.type === 'text')
              if (textBlock?.text) {
                const parsed = JSON.parse(textBlock.text)
                results = parsed.results || []
              }
            } catch {}
            if (!results.length) results = searchRes?.results || searchRes || []
            if (Array.isArray(results)) {
              // 清理 EXTERNAL_UNTRUSTED_CONTENT 标签
              const cleaned = results.map(r => ({
                ...r,
                title: this._cleanText(r.title),
                content: this._cleanText(r.content || r.snippet || '')
              }))
              allResults.push(...cleaned)
            }
          } catch (err) {
            logger.warn({ err: err.message }, '🔬 research: 单次搜索失败，继续')
          }
        }

        searchResults = this._filterResults(allResults, kwList.join(' '))
        logger.info({ count: searchResults.length }, '🔬 research: 搜索+过滤完成')
      } catch (err) {
        logger.warn({ err: err.message }, '🔬 research: 搜索流程失败，继续')
        searchResults = []
      }
    }

    const modelConfig = stepConfig.model || {}
    const taskType = modelConfig.taskType || 'analysis'
    const temperature = stepConfig.temperature ?? 0.7
    const maxTokens = stepConfig.maxTokens ?? 2000

    const ragContext = ragResults
      .map(c => `${c.heading ? `[${c.heading}] ` : ''}${c.content}`)
      .join('\n\n')
    const searchContext = Array.isArray(searchResults)
      ? searchResults.slice(0, 8).map((r, i) => `[素材${i + 1}] ${r.title || ''}: ${r.content || r.snippet || ''}`).join('\n\n')
      : ''

    const persona = stepConfig.persona || '你是中老年公众号的研究编辑。'
    const styleGuide = stepConfig.styleGuide || {}

    // ===== 改进④：prompt 加防编造约束 =====
    const systemPrompt = stepConfig.systemPrompt || [
      persona,
      '请围绕给定题目，结合搜索结果和知识库素材，输出研究摘要。',
      '',
      '要求：',
      '1. 目标读者是 50-75 岁读者和其家属。',
      '2. 输出的信息必须服务于"短文章写作"，不要写成学术综述。',
      '3. keyFacts 必须直接引用上方「最新资讯参考」中的素材，用 [素材N] 标注来源。',
      '4. 如果搜索素材中没有相关案例或数据，该条 keyFacts 写"无相关素材，建议用场景描写代替"，不要编造具体人名、地名、数字。',
      '5. outline 的每个要点必须引用具体素材，不要只写标题。',
      styleGuide.angle ? `6. ${styleGuide.angle}` : '',
      styleGuide.facts ? `7. ${styleGuide.facts}` : '',
      styleGuide.structure ? `8. ${styleGuide.structure}` : '',
      styleGuide.cues ? `9. ${styleGuide.cues}` : '9. styleCues 要总结写法，不要输出空泛词。',
      styleGuide.taboos ? `10. ${styleGuide.taboos}` : '10. 健康、医保、养老金、法律类内容必须谨慎，不做绝对结论。',
      '',
      '输出格式：JSON，格式如下：',
      '{',
      '  "articleAngle": "文章角度",',
      '  "keyFacts": ["[素材1] 具体案例或数据", "..."],',
      '  "styleCues": ["写法提示1", "写法提示2"],',
      '  "outline": ["要点1（引用素材）", "要点2", "要点3"],',
      '  "riskNotes": ["风险提示1"],',
      '  "imageDirections": ["配图方向1"]',
      '}'
    ].filter(Boolean).join('\n')

    const userPrompt = [
      `题目：${selectedTopic.title}`,
      `简介：${selectedTopic.intro}`,
      `角度：${selectedTopic.angle}`,
      styleBrief.length > 0 ? `\n写法参考：\n${styleBrief.join('\n')}` : '',
      ragContext ? `\n知识库参考：\n${ragContext}` : '',
      searchContext ? `\n最新资讯参考：\n${searchContext}` : '',
      !searchContext ? '\n注意：本次未搜索到相关素材，keyFacts 和 outline 中请注明"无相关素材"，不要编造数据。' : ''
    ].filter(Boolean).join('\n')

    const model = modelRouter.route(taskType)
    const { content, usage } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature, maxTokens })

    let research = null

    try {
      const jsonStr = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
      research = JSON.parse(jsonStr)
    } catch {
      research = this._fallbackResearch(selectedTopic)
    }

    logger.info({ angle: research?.articleAngle?.slice(0, 40), factCount: research?.keyFacts?.length }, '✅ research: 研究完成')

    return {
      ok: true,
      output: { research },
      usage
    }
  }

  /**
   * 改进①：用 LLM 从话题标题中提取搜索关键词
   */
  async _extractKeywords(topic) {
    try {
      const model = modelRouter.route('analysis')
      const { content } = await model.chat([
        { role: 'system', content: '从以下话题中提取 2-4 个搜索关键词，用空格分隔，只输出关键词，不要其他内容。\n\n示例：\n话题：老伴总说没事，可他悄悄把降压药分装进维生素瓶里\n关键词：老年人 降压药 分装 维生素瓶\n\n话题：退休后老伴把我的工资卡收走了\n关键词：退休 工资卡 老伴 夫妻财务' },
        { role: 'user', content: `话题：${topic.title}` }
      ], { temperature: 0.1, maxTokens: 50 })
      return content.trim().replace(/^关键词[：:]?\s*/i, '')
    } catch {
      return topic.title.replace(/[\u2018\u2019？！。，、的了是我他她]*/g, '').trim().slice(0, 30)
    }
  }

  /**
   * 改进③：过滤无关搜索结果
   */
  /**
   * 清理搜索结果中的安全标签和多余空白
   */
  _cleanText(text) {
    if (!text) return ''
    return text
      .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '')
      .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '')
      .replace(/Source: Web Search\s*---\s*/g, '')
      .replace(/\n+/g, ' ')
      .trim()
  }

  _filterResults(results, keywordsOrTopic) {
    if (!Array.isArray(results) || results.length === 0) return []

    // 支持传入关键词字符串或 topic 对象
    const keywordStr = typeof keywordsOrTopic === 'string'
      ? keywordsOrTopic
      : (keywordsOrTopic.title || '')
    const coreWords = keywordStr
      .split(/\s+/)
      .filter(w => w.length >= 2)

    const filtered = results.filter(r => {
      const text = ((r.title || '') + ' ' + (r.content || r.snippet || '')).toLowerCase()
      return coreWords.some(w => text.includes(w.toLowerCase()))
    })

    const seen = new Set()
    return filtered.filter(r => {
      const key = (r.title || '').slice(0, 40)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  _fallbackResearch(topic) {
    return {
      articleAngle: topic.angle || '从家庭日常场景切入，给出实用建议',
      keyFacts: [
        '无相关素材，建议用场景描写代替'
      ],
      styleCues: [
        '多用"先、再、最后"这种顺序表达，降低阅读负担。',
        '段落短，别一次塞太多信息。',
        '多写家庭里常见对话，让读者觉得像自己家的事。'
      ],
      outline: [
        '为什么这件事现在值得注意',
        '最容易忽略的几个细节',
        '家里今天就能做的行动清单'
      ],
      riskNotes: [
        '不要写绝对疗效、偏方或确定性政策判断。'
      ],
      imageDirections: [
        '家庭生活场景、自然光、温暖但不做作'
      ]
    }
  }
}

module.exports = ResearchStep

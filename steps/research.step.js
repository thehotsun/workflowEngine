'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

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
 * @workflow-config
 * - 无需配置，自动从context读取
 * 
 * @requires ['selectedTopic'] - 已选定的话题
 * @provides ['research'] - 完整的研究结果对象
 */
class ResearchStep extends BaseStep {
  get name() { return 'research' }
  get description() { return '围绕已选话题做写作前研究，输出角度、事实点、大纲、风险提示等结构化结果（LLM）' }
  get category() { return 'content-creation' }
  get timeout() { return 40000 }
  get requires() { return ['selectedTopic'] }
  get provides() { return ['research'] }

  async execute(context) {
    const selectedTopic = context.get('selectedTopic')
    const ragResults = context.get('ragResults', [])
    const searchResults = context.get('searchResults', [])
    const styleBrief = context.get('styleBrief', [])

    const ragContext = ragResults
      .map(c => `${c.heading ? `[${c.heading}] ` : ''}${c.content}`)
      .join('\n\n')
    const searchContext = Array.isArray(searchResults)
      ? searchResults.slice(0, 3).map(r => r.content || r.snippet || '').join('\n\n')
      : ''

    const systemPrompt = `你是中老年公众号的研究编辑。
请围绕给定题目，结合当前中文公开网页和适合中老年公众号的高阅读写法，输出研究摘要。

要求：
1. 目标读者是 50-75 岁读者和其家属。
2. 输出的信息必须服务于"短文章写作"，不要写成学术综述。
3. 健康、医保、养老金、法律类内容必须谨慎，不做绝对结论。
4. styleCues 要总结写法，不要输出空泛词。

输出格式：JSON，格式如下：
{
  "articleAngle": "文章角度",
  "keyFacts": ["关键事实1", "关键事实2"],
  "styleCues": ["写法提示1", "写法提示2"],
  "outline": ["大纲1", "大纲2", "大纲3"],
  "riskNotes": ["风险提示1"],
  "imageDirections": ["配图方向1"]
}
`

    const userPrompt = [
      `题目：${selectedTopic.title}`,
      `简介：${selectedTopic.intro}`,
      `角度：${selectedTopic.angle}`,
      styleBrief.length > 0 ? `\n写法参考：\n${styleBrief.join('\n')}` : '',
      ragContext ? `\n知识库参考：\n${ragContext}` : '',
      searchContext ? `\n最新资讯参考：\n${searchContext}` : ''
    ].filter(Boolean).join('\n')

    const model = modelRouter.route('analysis')
    const { content, usage } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ])

    let research = null

    try {
      const jsonStr = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
      research = JSON.parse(jsonStr)
    } catch {
      // 如果解析失败，使用 fallback 数据
      research = this._fallbackResearch(selectedTopic)
    }

    return {
      ok: true,
      output: { research },
      usage
    }
  }

  _fallbackResearch(topic) {
    return {
      articleAngle: topic.angle || '从家庭日常场景切入，给出实用建议',
      keyFacts: [
        '开头从家里真实场景切入，增强代入感。',
        '全文只讲能马上做到的小动作，不讲大而空的原则。',
        '如果涉及健康或政策，要提醒读者以医生或官方窗口答复为准。'
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

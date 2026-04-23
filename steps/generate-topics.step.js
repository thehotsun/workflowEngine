'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

/**
 * generate-topics step - 生成多个候选话题
 *
 * @workflow-config
 * - _config.topics.count: 生成话题数量（默认 6）
 * - _config.topics.avoidDuplicates: 是否避免重复历史话题（默认 true）
 * - _config.accountProfile.preferredTopics: 账号偏好主题，会影响话题评分
 */
class GenerateTopicsStep extends BaseStep {
  get name() { return 'generate-topics' }
  get description() { return '基于热点和用户需求，用 LLM 生成多个候选话题（含标题、简介、角度、评分）' }
  get category() { return 'content-creation' }
  get timeout() { return 40000 }
  get requires() { return ['input', 'hotspots'] }
  get provides() { return ['topics', 'styleBrief', 'topicCandidates'] }

  _topicKey(text) {
    const lowered = String(text || '').trim().toLowerCase()
    return lowered.replace(/[^\w\u4e00-\u9fff]+/g, '')
  }

  _isTopicSelected(history, title) {
    const key = this._topicKey(title)
    return history.some(h => this._topicKey(h.title || '') === key)
  }

  _utf8Truncate(str, maxBytes) {
    const encoder = new TextEncoder()
    const bytes = encoder.encode(str)
    if (bytes.length <= maxBytes) return str
    let pos = maxBytes
    while (pos > 0 && (bytes[pos] & 0xc0) === 0x80) pos--
    return new TextDecoder('utf-8').decode(bytes.subarray(0, pos))
  }

  async execute(context, stepDef) {
    const input = context.get('input')
    const hotspots = context.get('hotspots')
    const conversationHistory = context.get('conversationHistory', [])
    const ragResults = context.get('ragResults', [])
    const searchResults = context.get('searchResults', [])
    const selectedTopicsHistory = context.get('selectedTopicsHistory', [])
    const config = context.get('_config') || {}
    const topicsConfig = config.topics || {}
    const accountProfile = config.accountProfile || {}
    const preferredTopics = accountProfile.preferredTopics || []
    const topicCount = topicsConfig.count || 6
    const avoidDuplicates = topicsConfig.avoidDuplicates !== false

    const ragContext = ragResults
      .map(c => `${c.heading ? `[${c.heading}] ` : ''}${c.content}`)
      .join('\n\n')
    const searchContext = Array.isArray(searchResults)
      ? searchResults.slice(0, 3).map(r => r.content || r.snippet || '').join('\n\n')
      : ''
    const hotspotsText = hotspots?.items
      ? hotspots.items.map(i => `- ${i.title}${i.hotness ? ` (热度：${i.hotness})` : ''}`).join('\n')
      : ''

    let content = ''
    let styleBrief = []
    let topics = []

    const systemPrompt = `你是一个服务 50-75 岁读者的中文公众号主编。
请根据用户需求，给出 ${topicCount} 个"短文章"候选题，供人工选择。

要求：
1. 读者是中老年人和会转发给父母的家属。
2. 标题必须清楚、具体、像真实公众号标题，不要像 AI 在做提纲。
3. 优先选择这些方向：健康提醒、退休生活、医保养老、家庭关系、反诈安全、换季出行、手机使用、小区生活。
4. 如果题目涉及健康、药物、养老金政策、法律，必须保守表达，不要夸张承诺。
5. styleBrief 要总结今天应该模仿的高阅读写法，不要写空话。

输出格式：JSON，格式如下：
{
  "styleBrief": ["写法1", "写法2", ...],
  "topics": [
    {
      "id": "T01",
      "title": "题目标题",
      "intro": "简介",
      "angle": "写作角度",
      "whyNow": "为什么今天写",
      "score": 9.2,
      "tags": ["标签1", "标签2"],
      "sourceClues": ["参考线索1"]
    },
    ...
  ]
}
`

    const userPromptParts = [`用户需求：${input}`]
    if (hotspotsText) userPromptParts.push(`\n今日热点：\n${hotspotsText}`)
    if (ragContext) userPromptParts.push(`\n知识库参考：\n${ragContext}`)
    if (searchContext) userPromptParts.push(`\n最新资讯参考：\n${searchContext}`)
    if (preferredTopics.length > 0) {
      userPromptParts.push(`\n账号偏好主题：${preferredTopics.join('、')}`)
    }
    const userPrompt = userPromptParts.join('\n')

    const model = modelRouter.route('analysis')
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    // 注入多轮历史（最近 3 条）
    for (const h of conversationHistory.slice(-3)) {
      if (h.userInput) messages.splice(1, 0, { role: 'user', content: h.userInput })
      if (h.topic) messages.splice(2, 0, { role: 'assistant', content: `上次主题：${h.topic}` })
    }

    try {
      const { content: modelContent, usage } = await model.chat(messages)
      content = modelContent

      try {
        const jsonStr = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
        const parsed = JSON.parse(jsonStr)
        styleBrief = Array.isArray(parsed.styleBrief) ? parsed.styleBrief : []
        topics = Array.isArray(parsed.topics) ? parsed.topics : []
      } catch {
        ;({ topics, styleBrief } = this._fallback(
          input,
          hotspots?.items || [],
          preferredTopics,
          selectedTopicsHistory,
          topicCount,
          avoidDuplicates
        ))
      }

      // 去重历史话题
      if (avoidDuplicates && Array.isArray(selectedTopicsHistory)) {
        topics = topics.filter(t => !this._isTopicSelected(selectedTopicsHistory, t.title))
      }

      // 确保 topics 有 id，并且数量符合要求
      topics = topics.slice(0, topicCount)
      topics = topics.map((t, idx) => ({
        id: t.id || `T${String(idx + 1).padStart(2, '0')}`,
        ...t,
      }))

      // 根据账号偏好调整分数
      if (preferredTopics.length > 0) {
        topics = topics.map(t => {
          const haystack = `${t.title} ${t.intro} ${t.angle} ${(t.tags || []).join(' ')}`
          let bonus = 0
          for (const keyword of preferredTopics) {
            if (haystack.includes(keyword)) {
              bonus += 0.35
            }
          }
          return {
            ...t,
            score: Math.min(10, Math.max(0, (t.score || 8) + bonus)),
          }
        })
        topics.sort((a, b) => (b.score || 0) - (a.score || 0))
      }

      // 再次设置正确的 id（可能顺序变了）
      topics = topics.map((t, idx) => ({
        ...t,
        id: `T${String(idx + 1).padStart(2, '0')}`,
      }))

      return {
        ok: true,
        output: {
          topics,
          styleBrief,
          topicCandidates: {
            generatedAt: new Date().toISOString(),
            styleBrief,
            topics,
          },
        },
        usage,
      }
    } catch {
      ;({ topics, styleBrief } = this._fallback(
        input,
        hotspots?.items || [],
        preferredTopics,
        selectedTopicsHistory,
        topicCount,
        avoidDuplicates
      ))

      return {
        ok: true,
        output: {
          topics,
          styleBrief,
          topicCandidates: {
            generatedAt: new Date().toISOString(),
            styleBrief,
            topics,
          },
        },
      }
    }
  }

  _fallback(input, hotspots, preferredTopics, selectedTopicsHistory, topicCount, avoidDuplicates) {
    const baseTopics = [
      {
        title: '夫妻过了50岁，最伤人的不是吵架，是这几种冷淡相处',
        intro: '夫妻相处题适合做高度共鸣型短文，读者容易代入自己的婚姻状态，也更容易转发给老伴和朋友。',
        angle: '不写大是大非，只写中老年夫妻日常里最容易忽略的疏离感。',
        whyNow: '家庭关系类内容在微信里天然有讨论度，尤其适合熟人转发和留言。',
        score: 9.2,
        tags: ['夫妻关系', '婚姻相处', '情绪共鸣'],
        sourceClues: ['情绪消费的核心之一，就是为情感共鸣和圈层认同买单'],
      },
      {
        title: '和子女住在一起，最伤感情的往往不是大事，是这几句话',
        intro: '家庭关系题适合做情绪共鸣型短文，容易让中老年读者觉得"这说的就是我家"。',
        angle: '从餐桌、带娃、作息这些小摩擦切入，给出更体面的说话方式。',
        whyNow: '代际沟通是最稳定的家庭情感内容之一，留言和转发潜力都高。',
        score: 9.1,
        tags: ['家庭关系', '代际沟通', '晚年生活'],
        sourceClues: ['银发人群兴趣偏好正转向追求自我成长与情感连接'],
      },
      {
        title: '退休后总舍不得花钱？很多老人真正担心的不是钱少',
        intro: '这是情感加生活方式题，适合写得柔和一点，容易引发共鸣和留言讨论。',
        angle: '把"舍不得花"背后的安全感、对子女的顾虑和晚年控制感讲透。',
        whyNow: '情绪价值和晚年安全感是中老年读者长期高关注议题。',
        score: 9.0,
        tags: ['退休', '情感', '晚年安全感'],
        sourceClues: ['银发人群消费与内容偏好正从功能诉求转向深层价值认同'],
      },
      {
        title: '家里有老人一定提醒：这3种新骗局，越熟的人越容易上当',
        intro: '反诈题一直稳定有阅读，适合写成家庭群可转发的提醒文，短小但传播性强。',
        angle: '不恐吓，重点拆解骗子怎么一步步让老人放松警惕。',
        whyNow: '安全感话题天然适合熟人传播，容易触发家人转发提醒。',
        score: 9.0,
        tags: ['反诈', '家庭', '提醒'],
        sourceClues: ['老年人常见电信诈骗套路再升级，社区连续发提醒'],
      },
      {
        title: '不是婆媳太难处，是很多家庭从一开始就把边界弄乱了',
        intro: '家庭伦理题更适合你的账号方向，容易带出真实案例和评论区讨论。',
        angle: '从帮忙带娃、给钱、住一起这些高频场景切入，讲清边界感。',
        whyNow: '家庭伦理不是热点快题，但在公众号熟人传播里很耐读、很耐讨论。',
        score: 9.1,
        tags: ['家庭伦理', '婆媳关系', '边界感'],
        sourceClues: ['高互动内容往往不只是信息，而是让读者忍不住代入自己的家庭位置'],
      },
      {
        title: '春天一暖就出门？老人踏青前先记住这4件小事',
        intro: '这篇写老人春季出门最容易忽略的保暖、带药、休息和补水，适合做实用提醒型短文。',
        angle: '从家里准备到路上应对，给出能直接照着做的清单。',
        whyNow: '四月出游和走亲访友明显增多，出行安全是眼下的高频话题。',
        score: 8.3,
        tags: ['春季', '出行', '老人安全'],
        sourceClues: (hotspots || []).slice(0, 2).map(h => h.title),
      },
      {
        title: '看病路上少跑一趟：异地就医前先把这份清单存好',
        intro: '医保流程类内容非常适合中老年账号，读者会收藏，也适合家属转给父母。',
        angle: '讲清楚出门前准备什么、窗口问什么、手机上查什么。',
        whyNow: '异地看病和探亲出行增多，流程类内容会更有即时价值。',
        score: 8.1,
        tags: ['医保', '异地就医', '实用清单'],
        sourceClues: ['退休人员关注异地就医结算和医保报销流程'],
      },
      {
        title: '夜里总醒别硬扛，50岁后睡不好先排查这3个习惯',
        intro: '围绕中老年常见睡眠问题，写成"先自查、再调整、再就医"的温和提醒文，阅读门槛低。',
        angle: '不用讲太多术语，只讲老人和家属最关心的真实场景和可执行动作。',
        whyNow: '换季时睡眠波动更明显，读者更容易被自己的生活感受击中。',
        score: 7.9,
        tags: ['睡眠', '健康', '换季'],
        sourceClues: (hotspots || []).slice(2, 4).map(h => h.title),
      },
    ]

    let topics = baseTopics.slice()

    // 去重历史话题
    if (avoidDuplicates && Array.isArray(selectedTopicsHistory)) {
      topics = topics.filter(t => !this._isTopicSelected(selectedTopicsHistory, t.title))
    }

    // 根据偏好调整分数
    if (preferredTopics.length > 0) {
      topics = topics.map(t => {
        const haystack = `${t.title} ${t.intro} ${t.angle} ${(t.tags || []).join(' ')}`
        let bonus = 0
        for (const keyword of preferredTopics) {
          if (haystack.includes(keyword)) {
            bonus += 0.35
          }
        }
        return {
          ...t,
          score: Math.min(10, Math.max(0, (t.score || 8) + bonus)),
        }
      })
      topics.sort((a, b) => (b.score || 0) - (a.score || 0))
    }

    // 再次确保数量符合要求，并设置正确的 id
    topics = topics.slice(0, topicCount).map((t, idx) => ({
      id: `T${String(idx + 1).padStart(2, '0')}`,
      ...t,
    }))

    const styleBrief = [
      '标题要一眼看懂，不拐弯，不用年轻化黑话。',
      '开头最好从饭桌、卧室、子女来电、带孙子、夫妻冷战这些家庭日常切入。',
      '情绪共鸣要先到，再给一个能落地的小提醒，别一上来讲大道理。',
      '段落短，细节真，像家里人说话，适合转发到家庭群和姐妹群。',
      '家庭伦理和夫妻矛盾题，重点写"委屈从哪来、边界怎么守、话该怎么说"。',
    ]

    return { topics, styleBrief }
  }
}

module.exports = GenerateTopicsStep

'use strict'

const BaseStep = require('./base.step')
const modelRouter = require('../models/router')

/**
 * write step - 生成文章
 *
 * @workflow-config
 * - _config.write.targetWordCount: { min, max } 文章字数范围（默认 900-1400）
 * - _config.write.digestLength: 摘要最大字数（默认 54）
 */
class WriteStep extends BaseStep {
  get name() { return 'write' }
  get description() { return '根据选题与研究结果生成完整结构化文章（标题、摘要、分节、配图提示词等）' }
  get category() { return 'content-creation' }
  get timeout() { return 60000 }
  get requires() { return ['selectedTopic', 'research'] }
  get provides() { return ['article', 'articleData', 'articleJson'] }

  async execute(context, stepDef) {
    const selectedTopic = context.get('selectedTopic')
    const research = context.get('research')
    const styleBrief = context.get('styleBrief', [])
    const ragResults = context.get('ragResults', [])
    const searchResults = context.get('searchResults', [])
    const config = context.get('_config') || {}
    const writeConfig = config.write || {}
    const targetWordCount = writeConfig.targetWordCount || { min: 900, max: 1400 }
    const digestLength = writeConfig.digestLength || 54

    const ragContext = ragResults
      .map(c => `${c.heading ? `[${c.heading}] ` : ''}${c.content}`)
      .join('\n\n')
    const searchContext = Array.isArray(searchResults)
      ? searchResults.slice(0, 3).map(r => r.content || r.snippet || '').join('\n\n')
      : ''

    const systemPrompt = `你是一个长期写中老年公众号的中文主笔。
请写一篇"短文章"，目标读者是 50-75 岁读者与其家属。

硬性要求：
1. 不要有 AI 味，不要出现"随着……发展""值得我们思考"等空话。
2. 开头必须从日常生活场景切入。
3. 整体长度控制在 ${targetWordCount.min}-${targetWordCount.max} 字左右，适合公众号快速阅读。
4. 段落短，语言稳，像一个有经验、会照顾读者情绪的编辑在说话。
5. 必须给出实用提醒，但不能制造恐慌。
6. 健康、药物、政策、报销、法律类内容要提醒读者以官方或专业人士意见为准。
7. 标题要像真实公众号标题，清楚、具体、好懂。
8. digest 控制在 ${digestLength} 个汉字以内。
9. inline_images 只允许使用这些 slot：after_lead、after_section_1、after_section_2、before_ending。

输出格式：JSON，格式如下：
{
  "title": "文章标题",
  "digest": "摘要（${digestLength}字以内）",
  "lead": ["引言段落1", "引言段落2"],
  "sections": [
    {
      "heading": "小节标题",
      "paragraphs": ["段落1", "段落2"],
      "highlight": "重点强调的一句话",
      "checklist": ["行动1", "行动2"]
    }
  ],
  "ending": ["结尾段落1", "结尾段落2"],
  "cover_prompt": "封面图提示词",
  "inline_images": [
    { "slot": "after_lead", "prompt": "图片提示词", "caption": "图片说明" }
  ],
  "tags": ["标签1", "标签2"]
}
`

    const userPrompt = [
      `选题信息：`,
      `题目：${selectedTopic.title}`,
      `简介：${selectedTopic.intro}`,
      `角度：${selectedTopic.angle}`,
      `为什么今天写：${selectedTopic.whyNow}`,
      `标签：${selectedTopic.tags?.join(', ') || ''}`,
      research?.articleAngle ? `\n文章角度：${research.articleAngle}` : '',
      research?.keyFacts?.length > 0 ? `\n关键事实：\n${research.keyFacts.map(k => `- ${k}`).join('\n')}` : '',
      research?.styleCues?.length > 0 ? `\n写法提示：\n${research.styleCues.map(s => `- ${s}`).join('\n')}` : '',
      styleBrief.length > 0 ? `\n今日写法参考：\n${styleBrief.map(s => `- ${s}`).join('\n')}` : '',
      research?.outline?.length > 0 ? `\n大纲参考：\n${research.outline.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : '',
      research?.riskNotes?.length > 0 ? `\n风险提示：\n${research.riskNotes.map(r => `- ${r}`).join('\n')}` : '',
      research?.imageDirections?.length > 0 ? `\n配图方向：\n${research.imageDirections.map(d => `- ${d}`).join('\n')}` : '',
      ragContext ? `\n知识库参考：\n${ragContext}` : '',
      searchContext ? `\n最新资讯参考：\n${searchContext}` : '',
      `\n请根据以上信息，按照要求的 JSON 格式输出文章。`
    ].filter(Boolean).join('\n')

    const model = modelRouter.route('writing')
    const { content, usage } = await model.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ])

    let articleData = null

    try {
      const jsonStr = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
      articleData = JSON.parse(jsonStr)
    } catch {
      // 如果解析失败，使用 fallback
      articleData = this._fallbackArticle(selectedTopic, research)
    }

    // 标准化文章数据，确保 cover_prompt 和 inline_images 存在
    articleData = this._normalizeArticle(articleData, selectedTopic)

    // 将结构化数据转换为 Markdown 格式的 article
    const article = this._formatArticle(articleData)

    return {
      ok: true,
      output: {
        article,
        articleData,
        articleJson: articleData
      },
      usage
    }
  }

  _normalizeArticle(data, topic) {
    const normalized = { ...data }

    // 确保基本字段存在
    normalized.title = String(normalized.title || topic.title || '').trim()
    normalized.digest = this._truncate(String(normalized.digest || topic.intro || '').trim(), 54)
    normalized.lead = Array.isArray(normalized.lead)
      ? normalized.lead
      : [topic.intro || '']
    normalized.sections = Array.isArray(normalized.sections)
      ? normalized.sections
      : []
    normalized.ending = Array.isArray(normalized.ending)
      ? normalized.ending
      : ['愿这篇短文，能帮家里少一点慌张，多一点从容。']
    normalized.tags = Array.isArray(normalized.tags)
      ? normalized.tags
      : (topic.tags || [])

    // 确保 cover_prompt 存在
    if (!normalized.cover_prompt || !String(normalized.cover_prompt).trim()) {
      normalized.cover_prompt = this._defaultCoverPrompt(topic, normalized)
    }

    // 确保 inline_images 存在并标准化
    if (!Array.isArray(normalized.inline_images) || normalized.inline_images.length === 0) {
      normalized.inline_images = this._defaultInlineImages(topic, normalized)
    } else {
      const allowedSlots = new Set(['after_lead', 'after_section_1', 'after_section_2', 'before_ending'])
      const seenSlots = new Set()
      const normalizedImages = []

      for (const img of normalized.inline_images) {
        if (!img || typeof img !== 'object') continue
        const slot = String(img.slot || '').trim()
        const prompt = String(img.prompt || '').trim()
        const caption = String(img.caption || '').trim()

        if (!allowedSlots.has(slot) || !prompt || seenSlots.has(slot)) continue
        normalizedImages.push({ slot, prompt, caption })
        seenSlots.add(slot)
      }

      // 补充默认图片（如果不够）
      for (const defaultImg of this._defaultInlineImages(topic, normalized)) {
        if (!seenSlots.has(defaultImg.slot)) {
          normalizedImages.push(defaultImg)
          seenSlots.add(defaultImg.slot)
        }
      }

      normalized.inline_images = normalizedImages
    }

    return normalized
  }

  _defaultCoverPrompt(topic, article) {
    const text = `${topic.title} ${topic.intro} ${article.title} ${article.digest}`.toLowerCase()

    if (text.includes('夫妻') || text.includes('婚姻') || text.includes('老伴')) {
      return '中老年夫妻在家中安静相处，真实生活摄影感，横版，适合公众号封面'
    }
    if (text.includes('家庭') || text.includes('子女') || text.includes('代际') || text.includes('婆媳')) {
      return '中老年家庭在家中交流的真实场景，温和自然，横版，适合公众号封面'
    }
    if (text.includes('手机') || text.includes('电话') || text.includes('诈骗') || text.includes('反诈')) {
      return '中老年人查看手机消息，神情认真，真实生活摄影感，横版，适合公众号封面'
    }
    if (text.includes('退休') || text.includes('花钱') || text.includes('存款') || text.includes('钱')) {
      return '退休后的中老年人在家中安静交谈，生活化摄影感，横版，适合公众号封面'
    }

    return '温暖、真实的中老年家庭生活场景，光线柔和，横版，适合公众号封面'
  }

  _defaultInlineImages(topic, article) {
    const text = `${topic.title} ${topic.intro} ${article.title}`.toLowerCase()

    if (text.includes('夫妻') || text.includes('婚姻') || text.includes('老伴')) {
      return [
        {
          slot: 'after_lead',
          prompt: '中老年夫妻在家里交谈，但情绪有些疏离，真实生活摄影感',
          caption: '表面在说话，不代表心里真的接住了对方。'
        },
        {
          slot: 'after_section_2',
          prompt: '中老年夫妻同处客厅却各做各的事，安静真实，生活化摄影',
          caption: '很多关系不是吵散的，而是慢慢冷下来的。'
        }
      ]
    }

    if (text.includes('家庭') || text.includes('子女') || text.includes('代际') || text.includes('婆媳')) {
      return [
        {
          slot: 'after_lead',
          prompt: '中老年父母和成年子女在家中交流，真实自然，生活摄影感',
          caption: '很多家庭的问题，不是大事，而是话没说到心里去。'
        },
        {
          slot: 'after_section_2',
          prompt: '家庭饭桌或客厅里的代际沟通场景，温和、真实、生活化',
          caption: '把边界和分寸说清楚，感情反而更稳。'
        }
      ]
    }

    if (text.includes('手机') || text.includes('电话') || text.includes('诈骗') || text.includes('反诈')) {
      return [
        {
          slot: 'after_lead',
          prompt: '中老年人接电话或查看手机消息的真实生活场景，摄影感',
          caption: '越像熟人来消息，越容易让人放松警惕。'
        },
        {
          slot: 'after_section_2',
          prompt: '家人陪老人一起核对手机信息或提醒风险，真实自然',
          caption: '关键不是吓人，而是帮家里多一道确认。'
        }
      ]
    }

    if (text.includes('退休') || text.includes('花钱') || text.includes('存款')) {
      return [
        {
          slot: 'after_lead',
          prompt: '退休后的中老年人在家中安静思考或交谈，真实生活摄影感',
          caption: '很多舍不得花，不只是因为钱，而是因为心里没底。'
        },
        {
          slot: 'after_section_2',
          prompt: '中老年夫妻整理账本或讨论生活安排，温和真实',
          caption: '把担心说出来，比一个人闷着更轻松。'
        }
      ]
    }

    return [
      {
        slot: 'after_lead',
        prompt: '中老年人和家属轻声交流，真实自然，家庭生活摄影感',
        caption: '把事情提前想清楚，心里会稳很多。'
      },
      {
        slot: 'after_section_2',
        prompt: '中老年人查看手机信息或整理清单的生活化场景，真实温和',
        caption: '真正有用的提醒，是看完就知道下一步怎么做。'
      }
    ]
  }

  _truncate(str, len) {
    if (!str) return ''
    let count = 0
    let result = ''
    for (const ch of str) {
      if (ch >= '\u4e00' && ch <= '\u9fff') {
        count += 1
      } else {
        count += 0.5
      }
      if (count > len) break
      result += ch
    }
    return result
  }

  _formatArticle(data) {
    const lines = []
    lines.push(`# ${data.title}`)
    lines.push('')
    if (data.lead) {
      lines.push(...data.lead)
      lines.push('')
    }
    if (data.sections) {
      for (const section of data.sections) {
        lines.push(`## ${section.heading}`)
        lines.push('')
        if (section.paragraphs) {
          lines.push(...section.paragraphs)
          lines.push('')
        }
        if (section.highlight) {
          lines.push(`> ${section.highlight}`)
          lines.push('')
        }
        if (section.checklist && section.checklist.length > 0) {
          lines.push('**行动清单：**')
          for (const item of section.checklist) {
            lines.push(`- ${item}`)
          }
          lines.push('')
        }
      }
    }
    if (data.ending) {
      lines.push(...data.ending)
    }
    return lines.join('\n')
  }

  _fallbackArticle(topic, research) {
    const title = topic.title
    let sections = []
    let lead = []
    let ending = []

    if (title.includes('夫妻') || title.includes('婚姻') || title.includes('老伴')) {
      lead = [
        '不少夫妻过了50岁，家里最安静的时候，不是在睡觉，而是在吃饭。筷子碰碗的声音有，电视机的声音有，就是两个人真正说到心里的话越来越少。',
        '很多人以为，年纪大了，能不吵就算好。可真正伤人的，往往不是拍桌子，不是红脸，而是那种一天到晚都没什么问题，却总让人心里发凉的冷淡相处。'
      ]
      sections = [
        {
          heading: '第一种冷淡：话在说，心却没接住',
          paragraphs: [
            '有些夫妻表面上也交流，早上问一句吃什么，晚上问一句门关了没，可一旦对方说起自己心里的委屈、身体的不舒服，或者对子女的担心，回应就只剩一句"行了，别想那么多"。',
            '这句话听着不像吵架，甚至像是在安慰人，但说多了，那个愿意开口的人就会慢慢闭嘴。因为他不是想听道理，他只是想知道：我说这些的时候，你到底有没有把我放在心上。'
          ],
          highlight: '中老年夫妻最怕的，不是没人做事，而是心事说出来以后像掉在地上，没人捡。',
          checklist: [
            '别急着下结论，先把对方的话听完',
            '少说"你想多了"，多说"我知道你心里不舒服"'
          ]
        },
        {
          heading: '第二种冷淡：家还在一起过，日子却像各过各的',
          paragraphs: [
            '很多夫妻到了这个阶段，生活秩序还在，饭照做，钱照管，孩子的事也会一起商量，可真正属于两个人的互动，已经越来越少。一个人盯着手机，一个人盯着电视，坐得很近，心却隔得很远。',
            '时间久了，家里不会立刻出大问题，可那种说不出的孤单会慢慢冒出来。尤其是退休以后，相处时间更多了，如果两个人除了琐事再没有别的话题，日子就容易越过越闷，越过越像搭伙。'
          ],
          highlight: '婚姻里最让人心凉的，不是争执太多，而是连争执都懒得有了。',
          checklist: [
            '每天留十分钟，只聊自己，不聊孩子和家务',
            '哪怕一起散个步，也比整天沉默坐着更能拉近关系',
            '把"我们已经老夫老妻了"换成"我还是得把你放在心上"'
          ]
        },
        {
          heading: '第三种冷淡：嘴上不闹，心里却一直记账',
          paragraphs: [
            '有些夫妻最危险的地方，不是当场吵，而是事情过去了，谁也不提，但谁也没放下。你记我年轻时不顾家，我记你这些年说话难听；你觉得自己忍了一辈子，我也觉得自己让了一辈子。',
            '这种旧账一旦堆多了，后来任何一件小事都可能变成导火索。表面上是在为一顿饭、一句话生气，实际上是在为那些多年没说开的委屈翻旧账。所以很多中老年夫妻看着平静，其实心里早就积了很厚一层霜。'
          ],
          highlight: '晚年的婚姻，拼的不是谁有理，而是谁愿意先把那层硬壳放下来一点。',
          checklist: [
            '别挑旧账最重的时候说，先挑心平一点的时候开口',
            '说委屈时少用"你总是"，多说"我那时候真的很难受"'
          ]
        }
      ]
      ending = [
        '夫妻过了50岁，最需要的已经不是轰轰烈烈，而是有话能接、有事能商量、委屈不会在心里越积越厚。很多婚姻不是败给大风大浪，而是败给了日复一日的冷。',
        '如果你也发现家里越来越安静，不妨先别急着问"我们是不是没感情了"，更该问的是：我们是不是太久没有好好听对方说过一句心里话了。能把这一步走回来，很多关系就还有暖起来的机会。'
      ]
    } else {
      lead = [
        '很多中老年读者最怕的，不是事情本身有多难，而是明明每天都在碰到，却总觉得没人把话说清楚。',
        '像今天这个话题，看起来不大，可一旦忽略，往往就是在家里、路上、窗口前多走弯路，甚至让家人跟着着急。'
      ]
      sections = [
        {
          heading: '先把最容易忽略的地方看清楚',
          paragraphs: [
            '不少人一遇到类似情况，第一反应是先凑合一下，想着等等再说。可对中老年人来说，真正麻烦的往往不是大问题，而是这些"先拖一拖"累出来的小问题。',
            '所以这类事情最稳妥的做法，不是慌着到处问，而是先把自己眼前的情况理一遍：现在最不方便的是什么，家里现成能做的准备有哪些，哪些步骤一定要提前确认。'
          ],
          highlight: '先把顺序理清楚，往往比临时多做两件事更省心。',
          checklist: [
            '把今天最需要处理的那一步先确定下来',
            '把证件、药物、手机、联系人这些基础东西提前备好'
          ]
        },
        {
          heading: '把话说到家里人最关心的地方',
          paragraphs: [
            '很多公众号文章写得太满，读者看完觉得有道理，可不知道自己接下来该干什么。中老年读者更在意的，其实是"我今天能不能照着做"。',
            '所以写这类文章时，最好把提醒落到生活场景里：比如出门前要不要多带一件衣服，手机里该不该提前查一查，遇到拿不准的情况是不是先问窗口或医生，而不是自己硬猜。'
          ],
          highlight: '能让读者转给老伴、子女、朋友，文章才真正有用。',
          checklist: [
            '一句话讲清楚为什么值得现在就注意',
            '一句话告诉读者今天回家后先做什么',
            '一句话提醒家属怎么帮父母少走弯路'
          ]
        },
        {
          heading: '真正稳妥的做法，是留一点余地',
          paragraphs: [
            '中老年人最需要的，不是被吓一跳，而是被稳稳接住。越是跟健康、钱、流程有关的话题，越要把语气放稳，把建议讲清楚，把"不确定的地方要再核实"这句话说在前面。',
            '如果你是家里的子女，也别只会说"你别管了我来弄"。更好的做法，是把流程简化成两三步，陪着老人一起过一遍，这样下一次他们心里也更有底。'
          ],
          highlight: '提醒不是制造焦虑，而是帮读者多一份准备。',
          checklist: [
            '遇到政策和报销问题，以官方窗口答复为准',
            '遇到身体不适或长期症状，以医生建议为准'
          ]
        }
      ]
      ending = [
        '对很多中老年读者来说，真正需要的从来不是"大道理"，而是一篇把顺序、细节和分寸讲清楚的短文章。',
        '如果今天把这几件事提前想到了，很多麻烦其实都能少一半。这也是这类内容最值得写、也最值得转发给家里人的地方。'
      ]
    }

    return {
      title,
      digest: this._truncate(topic.intro || '', 54),
      lead,
      sections,
      ending,
      tags: topic.tags || []
    }
  }
}

module.exports = WriteStep

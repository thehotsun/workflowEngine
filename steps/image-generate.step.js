'use strict'

const BaseStep = require('./base.step')

/**
 * image-generate step — 根据话题生成图片提示词
 * 
 * 基于选定的话题，自动生成适合公众号的图片提示词，包括：
 * 1. 封面图提示词（coverPrompt）- 横版，真实生活摄影感
 * 2. 文章内插图提示词（inlineImages）- 多个位置的配图建议
 * 
 * 根据话题内容自动匹配场景：
 * - 夫妻/婚姻话题 → 中老年夫妻在家相处
 * - 家庭/子女/代际/婆媳话题 → 家庭交流场景
 * - 手机/电话/诈骗/反诈话题 → 中老年人看手机场景
 * - 退休/花钱/存款话题 → 退休在家的真实生活
 * 
 * @workflow-config
 * - 无需配置，完全基于话题内容自动生成
 * 
 * @requires ['selectedTopic'] - 已选定的话题对象
 * @provides ['coverPrompt', 'inlineImages'] - 封面图和内插图提示词
 */
class ImageGenerateStep extends BaseStep {
  get name() { return 'image-generate' }
  get description() { return '根据选定话题自动匹配场景，生成封面图提示词和文章内插图提示词（无需调用图片 API）' }
  get category() { return 'content-creation' }
  get timeout() { return 60000 }
  get requires() { return ['selectedTopic'] }
  get provides() { return ['coverPrompt', 'inlineImages'] }

  async execute(context) {
    const selectedTopic = context.get('selectedTopic')
    const article = context.get('article', '')

    const coverPrompt = this._generateCoverPrompt(selectedTopic, article)
    const inlineImages = this._generateInlineImages(selectedTopic, article)

    return {
      ok: true,
      output: {
        coverPrompt,
        inlineImages
      }
    }
  }

  _generateCoverPrompt(topic, article) {
    const text = `${topic.title} ${topic.intro} ${topic.angle} ${article}`.toLowerCase()

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
      return '退休后的中老年人在家中安静思考或聊天，真实生活摄影感，横版，适合公众号封面'
    }
    if (text.includes('春天') || text.includes('踏青') || text.includes('出行')) {
      return '中老年人在公园或户外散步，阳光明媚，横版，适合公众号封面'
    }
    if (text.includes('健康') || text.includes('睡眠') || text.includes('看病') || text.includes('医保')) {
      return '中老年人在家中阅读健康资讯或与医生交流，温和真实，横版，适合公众号封面'
    }

    return '温暖、真实的中老年家庭生活场景，光线柔和，横版，适合公众号封面'
  }

  _generateInlineImages(topic, article) {
    const text = `${topic.title} ${topic.intro} ${topic.angle} ${article}`.toLowerCase()

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
          prompt: '退休后的中老年人在家中安静思考或聊天，真实生活摄影感',
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
}

module.exports = ImageGenerateStep

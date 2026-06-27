'use strict'

const { describe, it, expect } = require('@jest/globals')
const WriteStep = require('../../steps/content/write.step')
const { MockContext, createStepDef, createConfig } = require('../helpers')

describe('WriteStep', () => {
  const step = new WriteStep()

  it('should have correct metadata', () => {
    expect(step.name).toBe('write')
    expect(step.description).toContain('生成完整结构化文章')
    expect(step.category).toBe('content-creation')
    expect(step.timeout).toBe(60000)
    expect(step.requires).toContain('selectedTopic')
    expect(step.requires).toContain('research')
    expect(step.provides).toContain('article')
    expect(step.provides).toContain('articleData')
  })

  describe('_truncate', () => {
    it('should truncate Chinese text correctly', () => {
      // Chinese chars count as 1, so len=3 allows 3 chars: 这是一
      expect(step._truncate('这是一个测试', 3)).toBe('这是一')
    })

    it('should handle mixed content', () => {
      // English chars count as 0.5, Chinese as 1
      // H(0.5) + e(0.5) + l(0.5) + l(0.5) + o(0.5) = 2.5, then 你(1) would make 3.5 > 3
      const result = step._truncate('Hello你好World', 3)
      expect(result).toBe('Hello')
    })

    it('should return empty string for null', () => {
      expect(step._truncate(null, 10)).toBe('')
    })

    it('should return empty string for undefined', () => {
      expect(step._truncate(undefined, 10)).toBe('')
    })
  })

  describe('_normalizeArticle', () => {
    it('should normalize empty article', () => {
      const topic = { title: '测试标题', intro: '测试简介', tags: ['tag1'] }
      const result = step._normalizeArticle({}, topic)
      expect(result.title).toBe('测试标题')
      expect(result.digest).toBeDefined()
      expect(Array.isArray(result.lead)).toBe(true)
      expect(Array.isArray(result.sections)).toBe(true)
      expect(Array.isArray(result.ending)).toBe(true)
      expect(Array.isArray(result.tags)).toBe(true)
    })

    it('should preserve existing data', () => {
      const topic = { title: '原标题', intro: '原简介' }
      const data = {
        title: '新标题',
        lead: ['引言1'],
        sections: [{ heading: '小节1', paragraphs: ['段落1'] }],
        ending: ['结尾1'],
        tags: ['tag1']
      }
      const result = step._normalizeArticle(data, topic)
      expect(result.title).toBe('新标题')
      expect(result.lead).toEqual(['引言1'])
      expect(result.sections).toHaveLength(1)
      expect(result.ending).toEqual(['结尾1'])
      expect(result.tags).toEqual(['tag1'])
    })

    it('should ensure cover_prompt exists', () => {
      const topic = { title: '测试', intro: '简介' }
      const result = step._normalizeArticle({}, topic)
      expect(result.cover_prompt).toBeDefined()
      expect(typeof result.cover_prompt).toBe('string')
    })

    it('should ensure inline_images exists and is valid', () => {
      const topic = { title: '测试', intro: '简介' }
      const result = step._normalizeArticle({}, topic)
      expect(Array.isArray(result.inline_images)).toBe(true)
      // Should have default images
      expect(result.inline_images.length).toBeGreaterThan(0)
      // Each image should have required fields
      for (const img of result.inline_images) {
        expect(img.slot).toBeDefined()
        expect(img.prompt).toBeDefined()
      }
    })

    it('should filter invalid inline_images', () => {
      const topic = { title: '测试', intro: '简介' }
      const data = {
        inline_images: [
          { slot: 'after_lead', prompt: '有效图片' },
          { slot: 'invalid_slot', prompt: '无效slot' },
          null,
          { slot: 'after_lead', prompt: '重复slot' },
          { prompt: '缺少slot' }
        ]
      }
      const result = step._normalizeArticle(data, topic)
      // Should filter out invalid and duplicate
      const slots = result.inline_images.map(img => img.slot)
      expect(slots).toContain('after_lead')
      expect(slots).not.toContain('invalid_slot')
    })
  })

  describe('_formatArticle', () => {
    it('should format article to markdown', () => {
      const data = {
        title: '测试标题',
        lead: ['引言段落'],
        sections: [{
          heading: '小节标题',
          paragraphs: ['段落内容'],
          highlight: '重点句',
          checklist: ['行动1', '行动2']
        }],
        ending: ['结尾段落']
      }
      const md = step._formatArticle(data)
      expect(md).toContain('# 测试标题')
      expect(md).toContain('引言段落')
      expect(md).toContain('## 小节标题')
      expect(md).toContain('> 重点句')
      expect(md).toContain('**行动清单：**')
      expect(md).toContain('- 行动1')
      expect(md).toContain('结尾段落')
    })
  })

  describe('_fallbackArticle', () => {
    it('should generate fallback for marriage topic', () => {
      const topic = { title: '夫妻相处之道', intro: '测试', tags: [] }
      const result = step._fallbackArticle(topic, {})
      expect(result.title).toBe('夫妻相处之道')
      expect(result.lead.length).toBeGreaterThan(0)
      expect(result.sections.length).toBeGreaterThan(0)
      expect(result.ending.length).toBeGreaterThan(0)
    })

    it('should generate fallback for general topic', () => {
      const topic = { title: '健康养生小贴士', intro: '测试', tags: [] }
      const result = step._fallbackArticle(topic, {})
      expect(result.title).toBe('健康养生小贴士')
      expect(result.lead.length).toBeGreaterThan(0)
      expect(result.sections.length).toBeGreaterThan(0)
    })
  })

  describe('_defaultCoverPrompt', () => {
    it('should return marriage-related prompt', () => {
      const topic = { title: '夫妻关系', intro: '' }
      const article = { title: '', digest: '' }
      const result = step._defaultCoverPrompt(topic, article)
      expect(result).toContain('夫妻')
    })

    it('should return family-related prompt', () => {
      const topic = { title: '子女教育', intro: '' }
      const article = { title: '', digest: '' }
      const result = step._defaultCoverPrompt(topic, article)
      expect(result).toContain('家庭')
    })

    it('should return default prompt for unknown topic', () => {
      const topic = { title: '未知话题', intro: '' }
      const article = { title: '', digest: '' }
      const result = step._defaultCoverPrompt(topic, article)
      expect(result).toContain('中老年')
    })
  })
})

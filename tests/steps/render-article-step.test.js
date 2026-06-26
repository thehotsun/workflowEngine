'use strict'

const { describe, it, expect } = require('@jest/globals')
const RenderArticleStep = require('../../steps/render-article.step')
const { MockContext, createConfig } = require('../helpers')

describe('RenderArticleStep', () => {
  const step = new RenderArticleStep()

  it('should have correct metadata', () => {
    expect(step.name).toBe('render-article')
    expect(step.description).toContain('渲染')
    expect(step.category).toBe('content-creation')
    expect(step.requires).toContain('articleData')
    expect(step.provides).toContain('finalHtml')
    expect(step.provides).toContain('finalMarkdown')
  })

  describe('_escapeHtml', () => {
    it('should escape HTML special chars', () => {
      expect(step._escapeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
      )
    })

    it('should escape ampersand', () => {
      expect(step._escapeHtml('A & B')).toBe('A &amp; B')
    })

    it('should escape quotes', () => {
      expect(step._escapeHtml("it's")).toBe('it&#039;s')
    })

    it('should handle null/undefined', () => {
      expect(step._escapeHtml(null)).toBe('')
      expect(step._escapeHtml(undefined)).toBe('')
    })

    it('should handle non-string input', () => {
      expect(step._escapeHtml(123)).toBe('123')
    })
  })

  describe('_markdownToHtml', () => {
    it('should convert bold', () => {
      expect(step._markdownToHtml('**bold**')).toBe('<strong>bold</strong>')
    })

    it('should convert italic', () => {
      expect(step._markdownToHtml('*italic*')).toBe('<em>italic</em>')
    })

    it('should handle null/undefined', () => {
      expect(step._markdownToHtml(null)).toBe('')
      expect(step._markdownToHtml(undefined)).toBe('')
    })
  })

  describe('_buildAuthorCard', () => {
    it('should build author card with profile', () => {
      const profile = {
        accountName: '测试公众号',
        authorCard: {
          badge: '认证作者',
          subtitle: '测试副标题',
          highlights: ['亮点1'],
          footer: '测试结尾',
        },
      }
      const html = step._buildAuthorCard(profile)
      expect(html).toContain('测试公众号')
      expect(html).toContain('认证作者')
      expect(html).toContain('测试副标题')
      expect(html).toContain('亮点1')
      expect(html).toContain('测试结尾')
    })

    it('should render empty author card when profile has no values', () => {
      const html = step._buildAuthorCard({})
      // 不应包含任何品牌相关的硬编码兜底值
      expect(html).not.toContain('温柔')
      expect(html).toContain('<div style="margin-top: 48px; padding-top: 24px; border-top: 1px solid #eee;">')
    })
  })

  describe('_renderArticle', () => {
    it('should render complete article', () => {
      const articleData = {
        title: '测试标题',
        lead: ['引言1', '引言2'],
        sections: [
          {
            heading: '小节1',
            paragraphs: ['段落1'],
            highlight: '重点句',
            checklist: ['行动1'],
          },
        ],
        ending: ['结尾1'],
        inline_images: [
          {
            slot: 'after_lead',
            prompt: '测试图片',
            caption: '图片说明',
          },
        ],
      }
      const enabledSlots = new Set([
        'after_lead',
        'after_section_1',
        'after_section_2',
        'before_ending',
      ])
      const profile = { accountName: '测试' }

      const { finalHtml, finalMarkdown } = step._renderArticle(
        articleData,
        enabledSlots,
        profile,
      )

      expect(finalHtml).toContain('<h1')
      expect(finalHtml).toContain('测试标题')
      expect(finalHtml).toContain('<h2')
      expect(finalHtml).toContain('小节1')
      expect(finalHtml).toContain('重点句')
      expect(finalHtml).toContain('行动1')

      expect(finalMarkdown).toContain('# 测试标题')
      expect(finalMarkdown).toContain('## 小节1')
      expect(finalMarkdown).toContain('> 重点句')
    })

    it('should handle empty sections', () => {
      const articleData = {
        title: '标题',
        lead: [],
        sections: [],
        ending: [],
      }
      const enabledSlots = new Set()
      const { finalHtml, finalMarkdown } = step._renderArticle(
        articleData,
        enabledSlots,
        null,
      )
      expect(finalHtml).toContain('标题')
      expect(finalMarkdown).toContain('# 标题')
    })
  })

  describe('_extractImages', () => {
    it('should extract all images', () => {
      const articleData = {
        cover_prompt: '封面提示词',
        inline_images: [
          { slot: 'after_lead', prompt: '图片1', caption: '说明1' },
          { slot: 'after_section_1', prompt: '图片2', caption: '说明2' },
        ],
      }
      const enabledSlots = new Set(['after_lead', 'after_section_1'])
      const images = step._extractImages(articleData, enabledSlots)
      expect(images).toHaveLength(3) // cover + 2 inline
      expect(images[0].slot).toBe('cover')
      expect(images[1].slot).toBe('after_lead')
      expect(images[2].slot).toBe('after_section_1')
    })

    it('should filter disabled slots', () => {
      const articleData = {
        cover_prompt: '封面',
        inline_images: [
          { slot: 'after_lead', prompt: '图片1' },
          { slot: 'disabled_slot', prompt: '图片2' },
        ],
      }
      const enabledSlots = new Set(['after_lead'])
      const images = step._extractImages(articleData, enabledSlots)
      expect(images).toHaveLength(2) // cover + 1 enabled
    })
  })

  describe('execute', () => {
    it('should throw if no articleData', async () => {
      const context = new MockContext()
      await expect(step.execute(context)).rejects.toThrow('no articleData')
    })

    it('should render article successfully', async () => {
      const context = new MockContext({
        articleData: {
          title: '测试',
          lead: ['引言'],
          sections: [],
          ending: ['结尾'],
        },
        _config: createConfig(),
      })
      const result = await step.execute(context)
      expect(result.ok).toBe(true)
      expect(result.output.finalHtml).toContain('测试')
      expect(result.output.finalMarkdown).toContain('# 测试')
    })
  })
})

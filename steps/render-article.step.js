'use strict'

const BaseStep = require('./base.step')

/**
 * render-article step - 渲染文章为 HTML 和 Markdown 格式
 *
 * @workflow-config
 * - _config.accountProfile.authorCard: 作者卡片 HTML（可选）
 * - _config.images.enabledSlots: 启用的图片 slot 列表（默认全部启用）
 */
class RenderArticleStep extends BaseStep {
  get name() { return 'render-article' }
  get description() { return '将结构化文章数据渲染为发布用 HTML 与 Markdown，并提取图片位信息' }
  get category() { return 'content-creation' }
  get timeout() { return 30000 }
  get requires() { return ['articleData'] }
  get provides() { return ['finalMarkdown', 'finalHtml', 'images'] }

  _buildAuthorCard(profile) {
    const authorCard = profile.authorCard || {}
    const accountName = profile.accountName || '心栖书香'
    const badge = authorCard.badge || ''
    const subtitle = authorCard.subtitle || '陪你把家庭里的委屈、误会和边界，慢慢说清楚。'
    const highlights = Array.isArray(authorCard.highlights) ? authorCard.highlights : [
      '专注家庭关系、夫妻相处与代际沟通',
      '用温和、能共情的文字，写家里那些最难说出口的情绪',
      '愿每一篇短文，都能帮家里少一点慌张，多一点从容'
    ]
    const footer = authorCard.footer || '如果你觉得这篇文章像在说自己，也欢迎转给你关心的那个人。'

    let html = `<div style="margin-top: 48px; padding-top: 24px; border-top: 1px solid #eee;">`
    if (badge) {
      html += `<div style="font-size: 13px; color: #666; margin-bottom: 8px;">${this._escapeHtml(badge)}</div>`
    }
    html += `<div style="font-weight: 600; color: #111; font-size: 16px; margin-bottom: 8px;">${this._escapeHtml(accountName)}</div>`
    html += `<div style="font-size: 15px; color: #666; line-height: 1.8; margin-bottom: 16px;">${this._escapeHtml(subtitle)}</div>`
    if (highlights.length > 0) {
      html += `<ul style="margin: 0; padding-left: 20px;">`
      for (const h of highlights) {
        html += `<li style="font-size: 14px; color: #666; margin-bottom: 4px;">${this._escapeHtml(h)}</li>`
      }
      html += `</ul>`
    }
    html += `<div style="font-size: 14px; color: #666; margin-top: 16px; line-height: 1.8;">${this._escapeHtml(footer)}</div>`
    html += `</div>`
    return html
  }

  _escapeHtml(str) {
    if (!str) return ''
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  _markdownToHtml(str) {
    if (!str) return ''

    // 处理简单的 markdown：**bold** -> <strong>, *em* -> <em>
    let html = String(str)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
    return html
  }

  _renderArticle(articleData, enabledSlots, profile) {
    const data = { ...articleData }
    const sections = data.sections || []
    const inlineImages = (data.inline_images || []).filter(img => enabledSlots.has(img.slot))
    const authorCard = profile ? this._buildAuthorCard(profile) : `
      <div style="margin-top: 48px; padding-top: 24px; border-top: 1px solid #eee; font-size: 15px; color: #666; line-height: 1.8;">
        <p>这篇文章来自「心栖书香」，专为 50-75 岁读者及其家属服务，希望能帮你把生活过得更从容一点。</p>
        <p style="margin-top: 12px;">如果觉得有用，欢迎转发给你关心的人。</p>
      </div>
    `.trim()

    const parts = []
    const partsMarkdown = []

    // Title
    parts.push(`<h1 style="font-size: 26px; font-weight: 700; color: #111; margin-bottom: 8px; line-height: 1.4;">${this._escapeHtml(data.title)}</h1>`)
    partsMarkdown.push(`# ${data.title}`)
    partsMarkdown.push('')

    // Lead
    if (data.lead && data.lead.length > 0) {
      for (const p of data.lead) {
        parts.push(`<p style="font-size: 17px; line-height: 1.8; color: #333; margin-bottom: 16px;">${this._markdownToHtml(this._escapeHtml(p))}</p>`)
        partsMarkdown.push(p)
      }
      parts.push('')
      partsMarkdown.push('')
    }

    // After lead image
    const afterLeadImg = inlineImages.find(img => img.slot === 'after_lead')
    if (afterLeadImg) {
      parts.push(this._imagePlaceholder(afterLeadImg, 'after_lead'))
      partsMarkdown.push(`![${this._escapeHtml(afterLeadImg.caption || '')}]()`)
      partsMarkdown.push(`*${afterLeadImg.caption || ''}*`)
      partsMarkdown.push('')
    }

    // Sections
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]
      const sectionIndex = i + 1

      parts.push(`<h2 style="font-size: 20px; font-weight: 600; color: #111; margin-top: 32px; margin-bottom: 12px; line-height: 1.4;">${this._escapeHtml(sec.heading)}</h2>`)
      partsMarkdown.push(`## ${sec.heading}`)
      partsMarkdown.push('')

      if (sec.paragraphs) {
        for (const p of sec.paragraphs) {
          parts.push(`<p style="font-size: 17px; line-height: 1.8; color: #333; margin-bottom: 16px;">${this._markdownToHtml(this._escapeHtml(p))}</p>`)
          partsMarkdown.push(p)
        }
      }

      if (sec.highlight) {
        parts.push(`<blockquote style="margin: 20px 0; padding: 16px 20px; background: #f9f9f9; border-left: 4px solid #e67e22; color: #444; font-size: 16px; line-height: 1.7;">${this._markdownToHtml(this._escapeHtml(sec.highlight))}</blockquote>`)
        partsMarkdown.push(`> ${sec.highlight}`)
        partsMarkdown.push('')
      }

      if (sec.checklist && sec.checklist.length > 0) {
        parts.push(`<ul style="margin: 20px 0; padding-left: 20px;">`)
        partsMarkdown.push('**行动清单：**')
        for (const item of sec.checklist) {
          parts.push(`<li style="font-size: 16px; color: #333; line-height: 1.8; margin-bottom: 8px;">${this._markdownToHtml(this._escapeHtml(item))}</li>`)
          partsMarkdown.push(`- ${item}`)
        }
        parts.push(`</ul>`)
        partsMarkdown.push('')
      }

      // After section images
      const afterSectionImg = inlineImages.find(img => img.slot === `after_section_${sectionIndex}`)
      if (afterSectionImg) {
        parts.push(this._imagePlaceholder(afterSectionImg, `after_section_${sectionIndex}`))
        partsMarkdown.push(`![${this._escapeHtml(afterSectionImg.caption || '')}]()`)
        partsMarkdown.push(`*${afterSectionImg.caption || ''}*`)
        partsMarkdown.push('')
      }
    }

    // Before ending image
    const beforeEndingImg = inlineImages.find(img => img.slot === 'before_ending')
    if (beforeEndingImg) {
      parts.push(this._imagePlaceholder(beforeEndingImg, 'before_ending'))
      partsMarkdown.push(`![${this._escapeHtml(beforeEndingImg.caption || '')}]()`)
      partsMarkdown.push(`*${beforeEndingImg.caption || ''}*`)
      partsMarkdown.push('')
    }

    // Ending
    if (data.ending && data.ending.length > 0) {
      for (const p of data.ending) {
        parts.push(`<p style="font-size: 17px; line-height: 1.8; color: #333; margin-bottom: 16px;">${this._markdownToHtml(this._escapeHtml(p))}</p>`)
        partsMarkdown.push(p)
      }
    }

    // Author card
    parts.push(authorCard)

    const finalHtml = `<article style="max-width: 720px; margin: 0 auto; padding: 24px 16px;">${parts.join('\n')}</article>`
    const finalMarkdown = partsMarkdown.join('\n')

    return { finalHtml, finalMarkdown }
  }

  _imagePlaceholder(img, slot) {
    const caption = img.caption || ''
    return `
      <figure style="margin: 24px 0; text-align: center;">
        <div data-image-slot="${slot}" data-image-prompt="${this._escapeHtml(img.prompt)}" style="width: 100%; min-height: 300px; background: #f5f5f5; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #888;">
          [图片待生成：${this._escapeHtml(img.prompt.slice(0, 50))}${img.prompt.length > 50 ? '...' : ''}]
        </div>
        ${caption ? `<figcaption style="margin-top: 8px; font-size: 14px; color: #666;">${this._escapeHtml(caption)}</figcaption>` : ''}
      </figure>
    `.trim()
  }

  _extractImages(articleData, enabledSlots) {
    const inlineImages = (articleData.inline_images || []).filter(img => enabledSlots.has(img.slot))

    const images = []

    // Cover image
    if (articleData.cover_prompt) {
      images.push({
        slot: 'cover',
        prompt: articleData.cover_prompt,
        caption: null
      })
    }

    // Inline images
    for (const img of inlineImages) {
      images.push({
        slot: img.slot,
        prompt: img.prompt,
        caption: img.caption
      })
    }

    return images
  }

  async execute(context, stepDef) {
    const articleData = context.get('articleData')
    const config = context.get('_config') || {}
    const accountProfile = config.accountProfile || {}
    const imagesConfig = config.images || {}
    const enabledSlots = new Set(imagesConfig.enabledSlots || ['after_lead', 'after_section_1', 'after_section_2', 'before_ending'])

    const { finalHtml, finalMarkdown } = this._renderArticle(articleData, enabledSlots, accountProfile)
    const images = this._extractImages(articleData, enabledSlots)

    return {
      ok: true,
      output: {
        finalMarkdown,
        finalHtml,
        images
      }
    }
  }
}

module.exports = RenderArticleStep

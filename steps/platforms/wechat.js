'use strict'

/**
 * WeChat Official Account platform adapter
 *
 * 对应参考：wechat-auto-main/src/wechat_api.py WeChatClient
 *
 * API endpoints:
 *   GET  /cgi-bin/token                         — 获取 access_token
 *   POST /cgi-bin/media/uploadimg               — 上传正文图片，返回 url
 *   POST /cgi-bin/material/add_material?type=thumb — 上传封面素材，返回 media_id
 *   POST /cgi-bin/draft/add                     — 新建草稿，返回 media_id
 */

const fs = require('fs')
const path = require('path')
const config = require('../../config')
const RenderArticleStep = require('../render-article.step')

const API_BASE = 'https://api.weixin.qq.com'

class WeChatPlatform {
  constructor(platformConfig = {}) {
    this.appId = String(platformConfig.appId || config.WECHAT_APP_ID || '').trim()
    this.appSecret = String(platformConfig.appSecret || config.WECHAT_APP_SECRET || '').trim()
    this.author = String(platformConfig.author || config.WECHAT_AUTHOR || '').trim()
    this.showCoverPic = Number(platformConfig.showCoverPic != null ? platformConfig.showCoverPic : (config.WECHAT_SHOW_COVER_PIC || 0))
    this.needOpenComment = Number(platformConfig.needOpenComment != null ? platformConfig.needOpenComment : (config.WECHAT_NEED_OPEN_COMMENT != null ? config.WECHAT_NEED_OPEN_COMMENT : 1))
    this.onlyFansCanComment = Number(platformConfig.onlyFansCanComment != null ? platformConfig.onlyFansCanComment : (config.WECHAT_ONLY_FANS_CAN_COMMENT || 0))
    this.tokenCachePath = path.resolve(
      process.cwd(),
      String(platformConfig.tokenCachePath || config.WECHAT_TOKEN_CACHE_PATH || 'data/wechat_token_cache.json')
    )
  }

  configured() {
    return Boolean(this.appId && this.appSecret)
  }

  async publish(context) {
    if (!this.configured()) {
      return { platform: 'wechat', ok: true, skipped: true, reason: 'not-configured' }
    }

    const articleData = context.get('articleData')
    const finalHtml = context.get('finalHtml')
    const coverImagePath = context.get('coverImagePath') || null
    const inlineImagePaths = context.get('inlineImagePaths') || {}
    const workflowConfig = context.get('_config') || {}

    if (!coverImagePath) {
      throw new Error('要上传草稿箱，必须先生成或手动准备封面图。')
    }

    const uploadedInlineUrls = {}
    for (const [slot, filePath] of Object.entries(inlineImagePaths)) {
      if (!filePath) continue
      uploadedInlineUrls[slot] = await this.uploadImage(filePath)
    }

    // 用微信图片 URL 重新渲染 HTML
    const renderer = new RenderArticleStep()
    const accountProfile = (workflowConfig.accountProfile) || {}
    const imagesConfig = workflowConfig.images || {}
    const enabledSlots = new Set(imagesConfig.enabledSlots || ['after_lead', 'after_section_1', 'after_section_2', 'before_ending'])
    const { finalHtml: uploadedHtml } = renderer._renderArticle(articleData, enabledSlots, accountProfile, uploadedInlineUrls)

    if (!this.author) {
      throw new Error('微信发布需要配置作者名称（author），请在 flow config 的 platformPublish 中设置 author，或在 .env 中设置 WECHAT_AUTHOR')
    }

    const thumbMediaId = await this.uploadThumb(coverImagePath)

    const data = await this.createDraft({
      title: articleData.title || '',
      digest: articleData.digest || '',
      htmlContent: uploadedHtml,
      thumbMediaId
    })

    return {
      platform: 'wechat',
      ok: true,
      skipped: false,
      draftMediaId: data.media_id
    }
  }

  async getAccessToken(forceRefresh = false) {
    if (!this.configured()) throw new Error('未配置 WECHAT_APP_ID / WECHAT_APP_SECRET。')

    if (!forceRefresh) {
      try {
        const cached = JSON.parse(fs.readFileSync(this.tokenCachePath, 'utf8'))
        if (cached.access_token && Number(cached.expires_at || 0) > Math.floor(Date.now() / 1000) + 60) {
          return String(cached.access_token)
        }
      } catch (_) {}
    }

    const url = `${API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const data = await res.json()
    if (!data.access_token || (data.errcode && data.errcode !== 0)) {
      throw new Error(`获取微信 access_token 失败：${JSON.stringify(data)}`)
    }

    const expiresAt = Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 7200) - 120
    try {
      fs.mkdirSync(path.dirname(this.tokenCachePath), { recursive: true })
      fs.writeFileSync(this.tokenCachePath, JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }), 'utf8')
    } catch (_) {}

    return String(data.access_token)
  }

  async _postMultipart(url, fieldName, filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`找不到文件：${filePath}`)

    const boundary = `----WeChatBoundary${Math.random().toString(36).slice(2)}`
    const mimeType = _guessMime(filePath)
    const fileName = path.basename(filePath)
    const fileBytes = fs.readFileSync(filePath)

    const parts = [
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`),
      Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]
    const body = Buffer.concat(parts)

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body,
      signal: AbortSignal.timeout(120000)
    })
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch (_) { throw new Error('微信上传接口返回内容无法解析。') }
    if (typeof parsed !== 'object' || !parsed) throw new Error('微信上传接口返回结构异常。')
    return parsed
  }

  async uploadImage(filePath) {
    const token = await this.getAccessToken()
    const data = await this._postMultipart(`${API_BASE}/cgi-bin/media/uploadimg?access_token=${token}`, 'media', filePath)
    if (!data.url) throw new Error(`正文图片上传失败：${JSON.stringify(data)}`)
    return String(data.url)
  }

  async uploadThumb(filePath) {
    const token = await this.getAccessToken()
    const data = await this._postMultipart(`${API_BASE}/cgi-bin/material/add_material?access_token=${token}&type=thumb`, 'media', filePath)
    if (!data.media_id) throw new Error(`封面上传失败：${JSON.stringify(data)}`)
    return String(data.media_id)
  }

  async createDraft({ title, digest, htmlContent, thumbMediaId }) {
    const token = await this.getAccessToken()
    const payload = {
      articles: [{
        title,
        author: this.author,
        digest,
        content: htmlContent,
        thumb_media_id: thumbMediaId,
        show_cover_pic: this.showCoverPic,
        need_open_comment: this.needOpenComment,
        only_fans_can_comment: this.onlyFansCanComment
      }]
    }
    const res = await fetch(`${API_BASE}/cgi-bin/draft/add?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000)
    })
    const data = await res.json()
    if (!data.media_id) throw new Error(`创建草稿失败：${JSON.stringify(data)}`)
    return data
  }
}

function _guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

module.exports = WeChatPlatform

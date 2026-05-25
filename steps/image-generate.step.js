'use strict'

/**
 * image-generate step
 *
 * 做的事情：
 * 1. 从 articleData.cover_prompt / articleData.inline_images 读取图片提示词；如果没有，则根据 selectedTopic 和 article 自动生成。
 * 2. 把封面图提示词同步回 articleData.cover_prompt，把文中插图提示词同步回 articleData.inline_images。
 * 3. 为当前 workflow run 创建图片资源目录，默认保存到 data/article-assets/<runId>/assets。
 * 4. 先尝试从免费图库 Openverse 搜索并下载封面图和文中插图。
 * 5. 免费图库失败后，回退调用 OpenAI 兼容图片生成接口生成图片。
 * 6. 输出 coverImagePath、inlineImagePaths，供 render-article 插入真实图片、供 platform-publish 上传到公众号。
 * 7. 如果免费图库和生图接口都失败，本 step 不抛错，会返回空图片路径并把失败原因写入 imageNotes。
 *
 * 需要的配置：
 * - FREE_PHOTO_ENABLED：是否启用免费图库，默认启用；设为 0 / false / no / off 可关闭。
 * - OPENVERSE_API_BASE：Openverse API 地址，默认 https://api.openverse.org/v1。
 * - OPENVERSE_CLIENT_ID：Openverse client_id，需要放在 .env 里；用于自动获取免费图库 token。
 * - OPENVERSE_CLIENT_SECRET：Openverse client_secret，需要放在 .env 里；用于自动获取免费图库 token。
 * - OPENVERSE_ACCESS_TOKEN：可选；已有 token 会优先使用，过期后用 client_id/client_secret 自动刷新。
 * - FREE_PHOTO_TIMEOUT：免费图库搜索和下载超时时间，默认 60000 毫秒。
 * - IMAGE_ASSET_DIR：图片保存根目录，默认 data/article-assets。
 * - OPENAI_API_KEY：免费图库失败后调用图片生成接口所需；不配置则无法走 AI 生图兜底。
 * - OPENAI_BASE_URL：OpenAI 兼容接口地址，默认 https://api.openai.com/v1。
 * - OPENAI_IMAGE_MODEL：图片模型，默认 gpt-image-1。
 * - OPENAI_IMAGE_SIZE：图片尺寸，默认 1536x1024。
 * - OPENAI_IMAGE_QUALITY：图片质量，默认 low。
 *
 * workflow config 覆盖规则：
 * - 纯功能配置不允许在流程内覆盖，统一从 .env 读取。
 * - 和账号、品牌、平台身份有关的配置，才使用 env 作为默认值，并允许流程内覆盖。
 *
 * 直接运行说明：
 * - 想用免费图库，需要配置 OPENVERSE_CLIENT_ID 和 OPENVERSE_CLIENT_SECRET（去 https://api.openverse.org/v1/auth_tokens/register/ 免费注册）。
 * - 想用 AI 生图兜底，需要配置 OPENAI_API_KEY。
 * - 两个都不配置时 step 不会报错，图片路径返回空，render-article 降级为占位符，但公众号草稿箱发布会失败（必须有封面图）。
 *
 * @workflow-config
 * - 纯功能配置（API 密钥等）统一从 .env 读取，不在 workflow config 中覆盖
 *
 * @requires ['selectedTopic'] - 选定的话题
 * @provides ['coverPrompt', 'inlineImages', 'coverImagePath', 'inlineImagePaths', 'imageNotes', 'photoSources'] - 图片生成结果
 */

const fs = require('fs')
const path = require('path')
const { URLSearchParams } = require('url')
const OpenAI = require('openai')
const BaseStep = require('./base.step')
const config = require('../config')
const logger = require('../utils/logger')
const { enqueueMessage } = require('../persist/repos/outbox.repo')
const { outboxEmitter } = require('../trigger/outbox-worker')
// 使用 Node.js 22 原生 fetch（undici v8 的 fetch 对某些 CDN 返回 HTML）

// 暂时注释 access_token 相关内容，使用匿名模式
/*
const openverseTokenCache = {
  accessToken: '',
  expireAt: 0
}

function _openverseTokenCachePath() {
  return path.resolve(process.cwd(), config.OPENVERSE_TOKEN_CACHE_PATH || path.join('data', 'openverse_token_cache.json'))
}

function _loadOpenverseTokenFromFile() {
  try {
    const raw = fs.readFileSync(_openverseTokenCachePath(), 'utf8')
    const cached = JSON.parse(raw)
    if (cached.access_token && Number(cached.expires_at || 0) > Date.now() + 60000) {
      openverseTokenCache.accessToken = String(cached.access_token)
      openverseTokenCache.expireAt = Number(cached.expires_at)
    }
  } catch (_) {}
}

function _saveOpenverseTokenToFile(accessToken, expireAt) {
  try {
    const cachePath = _openverseTokenCachePath()
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ access_token: accessToken, expires_at: expireAt }), 'utf8')
  } catch (_) {}
}

// 优先使用 .env 手动注入的 token，否则从文件缓存恢复
const _manualToken = String(config.OPENVERSE_ACCESS_TOKEN || '').trim()
if (_manualToken) {
  openverseTokenCache.accessToken = _manualToken
  openverseTokenCache.expireAt = Date.now() + 12 * 60 * 60 * 1000 - 60000
} else {
  _loadOpenverseTokenFromFile()
}
*/

// OpenAI 动态 token 缓存（仅在配置了 OPENAI_TOKEN_URL 时生效）
const openaiTokenCache = {
  apiKey: null,
  expireAt: 0
}

/**
 * 调用 OPENAI_TOKEN_URL 刷新 OpenAI API Key / token。
 * 接口需返回 JSON { token: '...' } 或 { api_key: '...' }，过期时间可选字段 expires_in（秒）。
 * 若未配置 OPENAI_TOKEN_URL，则直接返回 config.OPENAI_API_KEY。
 */
async function refreshOpenAIToken() {
  const tokenUrl = String(config.OPENAI_TOKEN_URL || '').trim()
  if (!tokenUrl) return String(config.OPENAI_API_KEY || '').trim()

  const now = Date.now()
  if (openaiTokenCache.apiKey && now < openaiTokenCache.expireAt) {
    return openaiTokenCache.apiKey
  }

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'workflow-engine/1.0' },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`OpenAI token refresh failed: ${res.status}`)

  const data = await res.json()
  const newKey = String(data.token || data.api_key || '').trim()
  if (!newKey) throw new Error('OpenAI token refresh response missing token/api_key field')

  openaiTokenCache.apiKey = newKey
  openaiTokenCache.expireAt = now + Number(data.expires_in || 3600) * 1000 - 60000
  return newKey
}

// 暂时注释 access_token 获取函数，使用匿名模式
/*
async function getOpenverseToken(apiBase, timeout) {
  const now = Date.now()
  if (openverseTokenCache.accessToken && now < openverseTokenCache.expireAt) {
    return openverseTokenCache.accessToken
  }

  const clientId = String(config.OPENVERSE_CLIENT_ID || '').trim()
  const clientSecret = String(config.OPENVERSE_CLIENT_SECRET || '').trim()
  if (!clientId || !clientSecret) {
    return openverseTokenCache.accessToken
  }

  const res = await fetch(`${apiBase}/auth_tokens/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'workflow-engine/1.0',
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`Openverse token failed: ${res.status}`)

  const data = await res.json()
  if (!data.access_token) throw new Error('Openverse token response missing access_token')

  const expireAt = now + Number(data.expires_in || 43200) * 1000 - 60000
  openverseTokenCache.accessToken = data.access_token
  openverseTokenCache.expireAt = expireAt
  _saveOpenverseTokenToFile(data.access_token, expireAt)
  return openverseTokenCache.accessToken
}
*/

function isEnabled(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

function unique(items) {
  const seen = new Set()
  const results = []
  for (const item of items) {
    const value = String(item || '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    results.push(value)
  }
  return results
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function guessExtension(url, contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
  if (type === 'image/png') return '.png'
  if (type === 'image/webp') return '.webp'
  if (type === 'image/jpeg' || type === 'image/jpg') return '.jpg'

  try {
    const suffix = path.extname(new URL(url).pathname).toLowerCase()
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(suffix)) return suffix === '.jpeg' ? '.jpg' : suffix
  } catch (_) {}
  return '.jpg'
}

/**
 * image-generate step — 根据话题生成封面图和文中插图，调用图片 API 产出可发布图片
 */
class ImageGenerateStep extends BaseStep {
  get name() { return 'image-generate' }
  get description() { return '根据选定话题生成封面图和文章内插图，并调用图片 API 产出可发布图片' }
  get category() { return 'content-creation' }
  get timeout() { return 300000 }
  get requires() { return ['selectedTopic'] }
  get provides() { return ['coverPrompt', 'inlineImages', 'coverImagePath', 'inlineImagePaths', 'imageNotes', 'photoSources'] }

  async execute(context) {
    const selectedTopic = context.get('selectedTopic')
    const article = context.get('article', '')
    const articleData = context.get('articleData') || {}
    const runId = context.get('_runId') || Date.now().toString()

    const coverPrompt = articleData.cover_prompt || this._generateCoverPrompt(selectedTopic, article)
    const inlineImages = Array.isArray(articleData.inline_images) && articleData.inline_images.length > 0
      ? articleData.inline_images
      : this._generateInlineImages(selectedTopic, article)

    articleData.cover_prompt = coverPrompt
    articleData.inline_images = inlineImages

    const assetsRoot = path.resolve(process.cwd(), config.IMAGE_ASSET_DIR || 'data/article-assets')
    const assetsDir = path.join(assetsRoot, String(runId), 'assets')
    ensureDir(assetsDir)

    const imageNotes = []
    const photoSources = []
    const inlineImagePaths = {}

    let coverImagePath = null
    try {
      coverImagePath = await this._generateCoverImage({
        articleData,
        coverPrompt,
        assetsDir,
        imageNotes,
        photoSources
      })
    } catch (err) {
      if (err.isAuthFailed) {
        logger.error(
          { runId, step: this.name, error: err.message, allNotes: imageNotes },
          'image-generate step: 生图认证失败，暂停流程，等待操作人处理后从本步骤重试'
        )
        this._notifyPause({ context, runId, reason: err.message, imageNotes })
        return {
          ok: false,
          _wait: true,
          _waitType: 'operator_resume',
          output: {
            articleData,
            coverPrompt,
            inlineImages,
            coverImagePath: null,
            inlineImagePaths: {},
            imageNotes,
            photoSources,
            _pauseReason: err.message
          }
        }
      }
      imageNotes.push(`封面图生成失败：${err.message}`)
    }

    for (let i = 0; i < inlineImages.length; i++) {
      const imageItem = inlineImages[i]
      const slot = String(imageItem.slot || '').trim()
      const prompt = String(imageItem.prompt || '').trim()
      const caption = String(imageItem.caption || '').trim()
      if (!slot || !prompt) continue

      try {
        const imagePath = await this._generateInlineImage({
          articleData,
          prompt,
          caption,
          slot,
          index: i + 1,
          assetsDir,
          imageNotes,
          photoSources
        })
        if (imagePath) inlineImagePaths[slot] = imagePath
      } catch (err) {
        if (err.isAuthFailed) {
          logger.error(
            { runId, step: this.name, slot, error: err.message, allNotes: imageNotes },
            'image-generate step: 插图认证失败，暂停流程，等待操作人处理后从本步骤重试'
          )
          this._notifyPause({ context, runId, reason: err.message, imageNotes })
          return {
            ok: false,
            _wait: true,
            _waitType: 'operator_resume',
            output: {
              articleData,
              coverPrompt,
              inlineImages,
              coverImagePath,
              inlineImagePaths,
              imageNotes,
              photoSources,
              _pauseReason: err.message
            }
          }
        }
        imageNotes.push(`插图 ${i + 1}（${slot}）生成失败：${err.message}`)
      }
    }

    return {
      ok: true,
      output: {
        articleData,
        coverPrompt,
        inlineImages,
        coverImagePath,
        inlineImagePaths,
        imageNotes,
        photoSources
      }
    }
  }

  async _generateCoverImage({ articleData, coverPrompt, assetsDir, imageNotes, photoSources }) {
    const freePhoto = await this._freePhotoConfig()
    if (freePhoto.enabled) {
      try {
        const queries = this._buildPhotoQueries(`${articleData.title || ''} ${coverPrompt}`, 'cover')
        const result = await this._fetchFreePhoto({
          queries,
          slot: 'cover',
          outputPath: path.join(assetsDir, 'cover.jpg'),
          minWidth: 1200,
          preferLandscape: true,
          freePhoto
        })
        if (result) {
          photoSources.push(result.meta)
          imageNotes.push(`封面图免费图库搜索词：${result.meta.query}`)
          return result.path
        }
      } catch (err) {
        imageNotes.push(`封面图免费图库失败：${err.message}`)
      }
    }

    try {
      return await this._generateImageByOpenAI(coverPrompt, path.join(assetsDir, 'cover.png'), imageNotes)
    } catch (err) {
      imageNotes.push(`封面图提示词：${coverPrompt}\n失败原因：${err.message}`)
      if (err.isAuthFailed) throw err   // 认证失败向上抛，让 execute 暂停流程
      return null
    }
  }

  async _generateInlineImage({ articleData, prompt, caption, slot, index, assetsDir, imageNotes, photoSources }) {
    const freePhoto = await this._freePhotoConfig()
    if (freePhoto.enabled) {
      try {
        const queries = this._buildPhotoQueries(`${articleData.title || ''} ${prompt} ${caption}`, slot)
        const result = await this._fetchFreePhoto({
          queries,
          slot,
          outputPath: path.join(assetsDir, `inline_${index}.jpg`),
          minWidth: 1000,
          preferLandscape: true,
          freePhoto
        })
        if (result) {
          photoSources.push(result.meta)
          imageNotes.push(`插图 ${index}（${slot}）免费图库搜索词：${result.meta.query}`)
          return result.path
        }
      } catch (err) {
        imageNotes.push(`插图 ${index}（${slot}）免费图库失败：${err.message}`)
      }
    }

    try {
      return await this._generateImageByOpenAI(prompt, path.join(assetsDir, `inline_${index}.png`), imageNotes)
    } catch (err) {
      imageNotes.push(`插图 ${index}（${slot}）提示词：${prompt}\n失败原因：${err.message}`)
      if (err.isAuthFailed) throw err   // 认证失败向上抛
      return null
    }
  }

  async _freePhotoConfig() {
    const apiBase = String(config.OPENVERSE_API_BASE || 'https://api.openverse.org/v1').replace(/\/$/, '')
    const timeout = Number(config.FREE_PHOTO_TIMEOUT || 60000)

    return {
      enabled: isEnabled(config.FREE_PHOTO_ENABLED, true),
      apiBase,
      accessToken: '',  // 匿名模式，不使用 access_token
      timeout
    }
  }

  _notifyPause({ context, runId, reason, imageNotes }) {
    const channelId = context.get('channelId')
    if (!channelId) return
    const notes = imageNotes && imageNotes.length ? `\n详情：${imageNotes.slice(-3).join('；')}` : ''
    const content = [
      `⚠️ 图片生成步骤因认证失败已暂停`,
      `runId：${runId}`,
      `原因：${reason}${notes}`,
      ``,
      `请检查并更新 OPENAI_API_KEY / OPENAI_TOKEN_URL 配置，`,
      `然后回复任意内容即可从本步骤继续执行流程。`
    ].join('\n')
    try {
      const msgId = enqueueMessage({ runId, channelId, content })
      outboxEmitter.emit('new_message', { msgId, runId })
    } catch (notifyErr) {
      logger.warn({ runId, notifyErr: notifyErr.message }, 'image-generate step: 暂停通知发送失败')
    }
  }

  async _fetchFreePhoto({ queries, slot, outputPath, minWidth, preferLandscape, freePhoto }) {
    const seenUrls = new Set()
    for (const query of unique(queries)) {
      const assets = await this._searchFreePhotos(query, freePhoto)
      for (const asset of assets) {
        if ((asset.url && seenUrls.has(asset.url)) || (asset.fallbackUrl && seenUrls.has(asset.fallbackUrl))) continue
        if (asset.url) seenUrls.add(asset.url)
        if (asset.fallbackUrl) seenUrls.add(asset.fallbackUrl)
        if (preferLandscape && asset.width && asset.height && asset.width < asset.height) continue
        if (asset.width && asset.width < minWidth) continue

        for (const url of [asset.url, asset.fallbackUrl]) {
          if (!url) continue
          try {
            const finalPath = await this._downloadImage(url, outputPath, freePhoto.timeout)
            return {
              path: finalPath,
              meta: {
                slot,
                provider: 'openverse',
                query,
                title: asset.title,
                creator: asset.creator,
                creator_url: asset.creatorUrl,
                license: asset.license,
                license_version: asset.licenseVersion,
                source_page: asset.sourcePage,
                download_url: url,
                local_path: finalPath,
                width: asset.width,
                height: asset.height
              }
            }
          } catch (_) {}
        }
      }
    }
    return null
  }

    async _searchFreePhotos(query, freePhoto) {
    // 1. 构建 URL 参数
    const params = new URLSearchParams({
      q: query,
      page_size: '12',
      license_type: 'commercial',
      category: 'photograph',
      mature: 'false'
    });

    // 2. 伪造真实浏览器的请求头
    const headers = {
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'WorkflowEngine/1.0'
    };

    // 3. 如果提供了 accessToken，则添加 Authorization 头
    if (freePhoto.accessToken) {
      headers['Authorization'] = `Bearer ${freePhoto.accessToken}`;
    }

    try {
      const response = await fetch(`${freePhoto.apiBase}/images/?${params.toString()}`, {
        headers,
        signal: AbortSignal.timeout(freePhoto.timeout || 8000)
      });

      if (!response.ok) {
        throw new Error(`Openverse search failed: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        const text = await response.text();
        throw new Error(`Openverse returned non-JSON (${contentType}): ${text.substring(0, 100)}`);
      }

      const data = await response.json();
      const items = Array.isArray(data.results) ? data.results : [];

      // 6. 返回格式化的图片数据
      return items.map(item => ({
        title: String(item.title || '').trim(),
        url: String(item.url || '').trim(),
        fallbackUrl: String(item.thumbnail || '').trim(),
        creator: String(item.creator || '').trim(),
        creatorUrl: String(item.creator_url || '').trim(),
        license: String(item.license || '').trim(),
        licenseVersion: String(item.license_version || '').trim(),
        sourcePage: String(item.foreign_landing_url || item.detail_url || '').trim(),
        width: Number(item.width || 0),
        height: Number(item.height || 0)
      })).filter(item => item.url || item.fallbackUrl);

    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch from Openverse');
      // 返回空数组作为失败的降级方案
      return [];
    }
  }

  async _downloadImage(url, outputPath, timeout) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'workflow-engine/1.0' },
      signal: AbortSignal.timeout(timeout)
    })
    if (!res.ok) throw new Error(`download image failed: ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length) throw new Error('downloaded image is empty')

    ensureDir(path.dirname(outputPath))
    const finalPath = outputPath.replace(path.extname(outputPath), guessExtension(url, res.headers.get('content-type')))
    fs.writeFileSync(finalPath, buffer)
    return finalPath
  }

  async _generateImageByOpenAI(prompt, outputPath, imageNotes) {
    const stepErrors = imageNotes ? [...imageNotes] : []

    const attemptGenerate = async (apiKey) => {
      if (!apiKey) throw new Error('未配置 OPENAI_API_KEY，无法生成配图')

      const client = new OpenAI({
        apiKey,
        baseURL: config.OPENAI_BASE_URL || 'https://api.openai.com/v1'
      })
      const imageTimeoutMs = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 120_000
      let response
      try {
        const imgController = new AbortController()
        const imgTimer = setTimeout(() => imgController.abort(), imageTimeoutMs)
        try {
          response = await client.images.generate({
            model: config.OPENAI_IMAGE_MODEL || 'gpt-image-1',
            prompt,
            size: config.OPENAI_IMAGE_SIZE || '1536x1024',
            quality: config.OPENAI_IMAGE_QUALITY || 'low'
          }, { signal: imgController.signal })
        } finally {
          clearTimeout(imgTimer)
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.message?.includes('aborted')) {
          throw new Error(`生图接口超时（${imageTimeoutMs / 1000}秒）`)
        }
        // OpenAI SDK 将 401 封装在 err.status 里
        const status = err.status || err.statusCode || (err.response && err.response.status)
        if (status === 401) {
          const authErr = Object.assign(new Error(`生图接口认证失败(401)：${err.message}`), { isAuthFailed: true })
          throw authErr
        }
        throw err
      }

      const first = response.data && response.data[0]
      if (!first) throw new Error('生图接口没有返回图片数据')

      ensureDir(path.dirname(outputPath))
      if (first.b64_json) {
        fs.writeFileSync(outputPath, Buffer.from(first.b64_json, 'base64'))
        return outputPath
      }
      if (first.url) return this._downloadImage(first.url, outputPath, 300000)
      throw new Error('生图接口没有返回 b64_json 或 url')
    }

    // 第一次尝试：使用当前缓存 key
    let apiKey
    try {
      apiKey = await refreshOpenAIToken()
      return await attemptGenerate(apiKey)
    } catch (firstErr) {
      if (!firstErr.isAuthFailed) throw firstErr

      // 401：刷新 token 后重试一次
      logger.warn({ prompt: prompt.slice(0, 60) }, '生图接口 401，尝试刷新 token 后重试')
      // 清空缓存强制重新获取
      openaiTokenCache.apiKey = null
      openaiTokenCache.expireAt = 0

      try {
        apiKey = await refreshOpenAIToken()
        return await attemptGenerate(apiKey)
      } catch (secondErr) {
        // 二次仍失败：将本 step 全量错误输出到日志
        logger.error(
          {
            secondError: secondErr.message,
            firstError: firstErr.message,
            allStepErrors: stepErrors,
            prompt: prompt.slice(0, 120)
          },
          'image-generate step: 生图接口二次 401 仍失败，全量错误如下'
        )
        // 保留 isAuthFailed 标记，让上层决定是否暂停流程
        const finalErr = Object.assign(new Error(`生图接口认证二次失败：${secondErr.message}`), { isAuthFailed: true })
        throw finalErr
      }
    }
  }

  _buildPhotoQueries(text, slot) {
    const source = String(text || '')
    const queries = []

    // 中英混合搜索，提高匹配精度
    // 加 'chinese' 或 'asian' 前缀确保返回亚洲面孔
    const asian = 'chinese'

    if (['夫妻', '婚姻', '老伴'].some(token => source.includes(token))) {
      queries.push(`${asian} senior couple at home`, `${asian} elderly couple conversation`, `older ${asian} couple living room`)
    }
    if (['家庭', '子女', '儿女', '代际'].some(token => source.includes(token))) {
      queries.push(`${asian} senior family at home`, `${asian} parents and adult child`, `${asian} family conversation`)
    }
    if (source.includes('婆媳')) queries.push(`${asian} family women conversation`, `${asian} mother daughter at home`, `${asian} senior family kitchen`)
    if (['手机', '电话', '诈骗', '反诈', '消息'].some(token => source.includes(token))) {
      queries.push(`${asian} senior using smartphone`, `${asian} elderly phone call`, `${asian} senior checking phone`)
    }
    if (['看病', '医保', '医院', '门诊', '医生'].some(token => source.includes(token))) {
      queries.push(`${asian} senior patient doctor`, `${asian} elderly medical paperwork`, `${asian} senior clinic`)
    }
    if (['出门', '踏青', '外出', '旅行'].some(token => source.includes(token))) {
      queries.push(`${asian} senior going out`, `${asian} elderly walking outdoors`, `${asian} senior travel`)
    }
    if (['睡眠', '失眠', '夜里', '总醒'].some(token => source.includes(token))) {
      queries.push(`${asian} senior resting at home`, `${asian} elderly sitting on bed`, `${asian} senior bedroom`)
    }
    if (['退休', '花钱', '钱', '存款'].some(token => source.includes(token))) {
      queries.push(`${asian} retired couple discussion`, `${asian} senior planning expenses`, `${asian} elderly home finances`)
    }
    if (['健康', '养生', '运动'].some(token => source.includes(token))) {
      queries.push(`${asian} senior health exercise`, `${asian} elderly morning walk`, `${asian} senior fitness`)
    }

    // 兜底搜索词
    if (slot === 'cover') queries.push(`${asian} senior lifestyle home`, `${asian} elderly portrait warm`)
    else if (slot === 'before_ending') queries.push(`${asian} senior family warm`, `${asian} elderly couple walking`)
    else queries.push(`${asian} senior home conversation`, `${asian} elderly daily life`)

    // 如果仍然没有匹配，用通用搜索词
    if (queries.length === 0) {
      queries.push(`${asian} senior home`, `${asian} elderly family`, `${asian} older adult`)
    }

    queries.push('asian senior lifestyle home', 'senior lifestyle photo')
    return unique(queries)
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

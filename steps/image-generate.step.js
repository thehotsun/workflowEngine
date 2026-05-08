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
 * - OPENVERSE_ACCESS_TOKEN：Openverse token，需要放在 .env 里；用于调用免费图库搜索接口。
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
 * - 想用免费图库，需要配置 OPENVERSE_ACCESS_TOKEN（去 https://api.openverse.org/v1/auth_tokens/register/ 免费注册）。
 * - 想用 AI 生图兜底，需要配置 OPENAI_API_KEY。
 * - 两个都不配置时 step 不会报错，图片路径返回空，render-article 降级为占位符，但公众号草稿箱发布会失败（必须有封面图）。
 */

const fs = require('fs')
const path = require('path')
const { URLSearchParams } = require('url')
const OpenAI = require('openai')
const BaseStep = require('./base.step')
const config = require('../config')

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

    const coverImagePath = await this._generateCoverImage({
      articleData,
      coverPrompt,
      assetsDir,
      imageNotes,
      photoSources
    })

    for (let i = 0; i < inlineImages.length; i++) {
      const imageItem = inlineImages[i]
      const slot = String(imageItem.slot || '').trim()
      const prompt = String(imageItem.prompt || '').trim()
      const caption = String(imageItem.caption || '').trim()
      if (!slot || !prompt) continue

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
    const freePhoto = this._freePhotoConfig()
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
      return await this._generateImageByOpenAI(coverPrompt, path.join(assetsDir, 'cover.png'))
    } catch (err) {
      imageNotes.push(`封面图提示词：${coverPrompt}\n失败原因：${err.message}`)
      return null
    }
  }

  async _generateInlineImage({ articleData, prompt, caption, slot, index, assetsDir, imageNotes, photoSources }) {
    const freePhoto = this._freePhotoConfig()
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
      return await this._generateImageByOpenAI(prompt, path.join(assetsDir, `inline_${index}.png`))
    } catch (err) {
      imageNotes.push(`插图 ${index}（${slot}）提示词：${prompt}\n失败原因：${err.message}`)
      return null
    }
  }

  _freePhotoConfig() {
    return {
      enabled: isEnabled(config.FREE_PHOTO_ENABLED, true),
      apiBase: String(config.OPENVERSE_API_BASE || 'https://api.openverse.org/v1').replace(/\/$/, ''),
      accessToken: String(config.OPENVERSE_ACCESS_TOKEN || '').trim(),
      timeout: Number(config.FREE_PHOTO_TIMEOUT || 60000)
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
    const params = new URLSearchParams({
      q: query,
      page_size: '12',
      license_type: 'commercial',
      category: 'photograph',
      mature: 'false'
    })
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'workflow-engine/1.0'
    }
    if (freePhoto.accessToken) headers.Authorization = `Bearer ${freePhoto.accessToken}`

    const res = await fetch(`${freePhoto.apiBase}/images/?${params.toString()}`, { headers, signal: AbortSignal.timeout(freePhoto.timeout) })
    if (!res.ok) throw new Error(`Openverse search failed: ${res.status}`)
    const data = await res.json()
    const items = Array.isArray(data.results) ? data.results : []
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
    })).filter(item => item.url || item.fallbackUrl)
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

  async _generateImageByOpenAI(prompt, outputPath) {
    const apiKey = config.OPENAI_API_KEY
    if (!apiKey) throw new Error('未配置 OPENAI_API_KEY，无法生成配图')

    const client = new OpenAI({
      apiKey,
      baseURL: config.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    })
    const response = await client.images.generate({
      model: config.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      prompt,
      size: config.OPENAI_IMAGE_SIZE || '1536x1024',
      quality: config.OPENAI_IMAGE_QUALITY || 'low'
    })

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

  _buildPhotoQueries(text, slot) {
    const source = String(text || '')
    const queries = []

    if (['夫妻', '婚姻', '老伴'].some(token => source.includes(token))) {
      queries.push('asian senior couple at home', 'senior couple conversation at home', 'older couple living room')
    }
    if (['家庭', '子女', '儿女', '代际'].some(token => source.includes(token))) {
      queries.push('asian senior family at home', 'older parents and adult child at home', 'family conversation at home')
    }
    if (source.includes('婆媳')) queries.push('family women conversation at home', 'mother and adult daughter at home', 'senior family kitchen')
    if (['手机', '电话', '诈骗', '反诈', '消息'].some(token => source.includes(token))) {
      queries.push('senior using smartphone at home', 'older adult phone call at home', 'senior checking phone message')
    }
    if (['看病', '医保', '医院', '门诊', '医生'].some(token => source.includes(token))) {
      queries.push('senior patient consultation', 'older adult medical paperwork', 'senior clinic waiting room')
    }
    if (['出门', '踏青', '外出', '旅行'].some(token => source.includes(token))) {
      queries.push('senior getting ready to go out', 'older adult walking outdoors', 'senior travel preparation')
    }
    if (['睡眠', '失眠', '夜里', '总醒'].some(token => source.includes(token))) {
      queries.push('senior resting at home', 'older adult sitting on bed', 'senior bedroom routine')
    }
    if (['退休', '花钱', '钱', '存款'].some(token => source.includes(token))) {
      queries.push('retired couple home discussion', 'senior couple planning expenses', 'older adult home finances')
    }

    if (slot === 'cover') queries.push('senior lifestyle home', 'older adult portrait home')
    else if (slot === 'before_ending') queries.push('senior family warm moment', 'older couple walking together')
    else queries.push('senior home conversation', 'older adult daily life home')

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

'use strict'

const BaseStep = require('./base.step')
const WeChatPlatform = require('./platforms/wechat')

/**
 * platform-publish step — 将文章提交到发布平台草稿箱
 *
 * @workflow-config
 * - _config.publishing.platforms: 发布平台列表（公共配置）
 * - _config.platformPublish.platforms: 本 step 专属平台覆盖（可选）
 *
 * @requires ['articleData', 'finalHtml'] - 文章数据和渲染后的 HTML
 * @provides ['platformPublishResults', 'wechatDraftMediaId'] - 发布结果
 */
class PlatformPublishStep extends BaseStep {
  get name() { return 'platform-publish' }
  get description() { return '将文章提交到发布平台草稿箱，当前支持微信公众号并预留多平台扩展' }
  get category() { return 'output' }
  get retryable() { return true }
  get timeout() { return 180000 }
  get requires() { return ['articleData', 'finalHtml'] }
  get provides() { return ['platformPublishResults', 'wechatDraftMediaId'] }

  async execute(context, stepDef = {}) {
    const workflowConfig = context.get('_config') || {}
    const publishingConfig = workflowConfig.publishing || {}
    const stepConfig = workflowConfig[this._configKey] || {}
    const platforms = stepConfig.platforms
      || publishingConfig.platforms
      || []
    const enabledPlatforms = platforms.filter(platform => platform && platform.enabled !== false)

    if (enabledPlatforms.length === 0) {
      return {
        ok: true,
        output: {
          platformPublishResults: [],
          wechatDraftMediaId: null
        }
      }
    }

    const results = []
    let wechatDraftMediaId = null

    for (const platform of enabledPlatforms) {
      if (platform.type === 'wechat') {
        const result = await new WeChatPlatform(platform).publish(context)
        results.push(result)
        if (result.ok && result.draftMediaId) wechatDraftMediaId = result.draftMediaId
        continue
      }

      results.push({
        platform: platform.type || 'unknown',
        ok: true,
        skipped: true,
        reason: 'unsupported-platform'
      })
    }

    return {
      ok: true,
      output: {
        platformPublishResults: results,
        wechatDraftMediaId
      }
    }
  }
}

module.exports = PlatformPublishStep

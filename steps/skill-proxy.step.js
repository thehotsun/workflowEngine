'use strict'

const BaseStep = require('./base.step')
const openclawClient = require('../openclaw/client')
const logger = require('../utils/logger')

/**
 * 通用 OpenClaw Skill 代理
 * 复用 OpenClaw 全部 Skill 生态，无需为每个 skill 单独实现 step
 *
 * workflow 中使用示例:
 * {
 *   type: 'skill-proxy',
 *   skill: 'web-search',
 *   input: ctx => ({ query: ctx.get('topic') }),
 *   output: 'searchResults',
 *   timeout: 15000
 * }
 */
class SkillProxyStep extends BaseStep {
  get name() { return 'skill-proxy' }
  get description() { return '代理调用 OpenClaw Skill 生态能力，避免为每个外部能力单独实现 step' }
  get category() { return 'integration' }
  get timeout() { return 20_000 }  // web-search 可能需要更长时间

  async execute(context, stepDef) {
    const skillName = stepDef.skill
    if (!skillName) throw new Error('skill-proxy requires stepDef.skill')

    const inputData = typeof stepDef.input === 'function'
      ? stepDef.input(context)
      : (stepDef.input || {})

    logger.info({ skill: skillName, input: inputData }, `🔍 调用 OpenClaw Skill: ${skillName}`)

    // web-search 特殊处理：使用 web 工具的 search action
    const toolName = skillName === 'web-search' ? 'web_search' : skillName
    const action = skillName === 'web-search' ? 'search' : stepDef.action

    const result = await openclawClient.invokeTool(toolName, inputData, {
      action,
      sessionKey: stepDef.sessionKey,
      timeoutMs: stepDef.timeout || this.timeout,
      dryRun: stepDef.dryRun
    })

    logger.info({ skill: skillName, success: !!result }, `✅ Skill 调用完成：${skillName}`)

    return { ok: true, output: result }
  }
}

module.exports = SkillProxyStep

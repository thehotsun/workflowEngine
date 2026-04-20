'use strict'

const BaseStep = require('./base.step')
const openclawClient = require('../openclaw/client')

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
  get timeout() { return 15_000 }

  async execute(context, stepDef) {
    const skillName = stepDef.skill
    if (!skillName) throw new Error('skill-proxy requires stepDef.skill')

    const inputData = typeof stepDef.input === 'function'
      ? stepDef.input(context)
      : (stepDef.input || {})

    const result = await openclawClient.invokeTool(skillName, inputData, {
      action: stepDef.action,
      sessionKey: stepDef.sessionKey,
      timeoutMs: stepDef.timeout || this.timeout,
      dryRun: stepDef.dryRun
    })

    return { ok: true, output: result }
  }
}

module.exports = SkillProxyStep

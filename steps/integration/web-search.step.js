'use strict'

const SkillProxyStep = require('./skill-proxy.step')

/**
 * Web Search Step - 委托给 SkillProxyStep
 * 实际搜索功能通过 skill-proxy 调用 OpenClaw 的 web-search skill
 */
class WebSearchStep extends SkillProxyStep {
  get name() { return 'web-search' }
  get description() { return '通过 OpenClaw Skill 进行网络搜索' }
}

module.exports = WebSearchStep

'use strict'

const ScorePlatformBase = require('./score-platform-base.step')

class ScoreDiscordStep extends ScorePlatformBase {
  get name() { return 'score-discord' }
  get description() { return 'Discord 内容质量评分' }
  get platformKey() { return 'discordItems' }
  get platformLabel() { return 'Discord' }
}

module.exports = ScoreDiscordStep

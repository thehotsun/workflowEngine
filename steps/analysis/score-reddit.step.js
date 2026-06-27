'use strict'

const ScorePlatformBase = require('./score-platform-base.step')

class ScoreRedditStep extends ScorePlatformBase {
  get name() { return 'score-reddit' }
  get description() { return 'Reddit 内容质量评分' }
  get platformKey() { return 'redditItems' }
  get platformLabel() { return 'Reddit' }
  get evalLanguage() { return 'en' }
}

module.exports = ScoreRedditStep

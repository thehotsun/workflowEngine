'use strict'

const ScorePlatformBase = require('./score-platform-base.step')

class ScoreTwitterStep extends ScorePlatformBase {
  get name() { return 'score-twitter' }
  get description() { return 'X/Twitter 内容质量评分' }
  get platformKey() { return 'twitterItems' }
  get platformLabel() { return 'X/Twitter' }
  get evalLanguage() { return 'en' }
}

module.exports = ScoreTwitterStep

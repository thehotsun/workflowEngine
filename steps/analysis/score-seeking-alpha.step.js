'use strict'
const ScorePlatformBase = require('./score-platform-base.step')
class ScoreSeekingAlphaStep extends ScorePlatformBase {
  get name() { return 'score-seeking-alpha' }
  get description() { return 'Seeking Alpha 内容质量评分' }
  get platformKey() { return 'seekingAlphaItems' }
  get platformLabel() { return 'Seeking Alpha' }
}
module.exports = ScoreSeekingAlphaStep

'use strict'
const ScorePlatformBase = require('./score-platform-base.step')
class ScoreEastmoneyStep extends ScorePlatformBase {
  get name() { return 'score-eastmoney' }
  get description() { return '东方财富内容质量评分' }
  get platformKey() { return 'eastmoneyItems' }
  get platformLabel() { return '东方财富' }
}
module.exports = ScoreEastmoneyStep

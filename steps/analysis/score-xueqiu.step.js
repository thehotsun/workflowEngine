'use strict'
const ScorePlatformBase = require('./score-platform-base.step')
class ScoreXueqiuStep extends ScorePlatformBase {
  get name() { return 'score-xueqiu' }
  get description() { return '雪球内容质量评分' }
  get platformKey() { return 'xueqiuItems' }
  get platformLabel() { return '雪球' }
}
module.exports = ScoreXueqiuStep

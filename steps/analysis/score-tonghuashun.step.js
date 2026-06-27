'use strict'
const ScorePlatformBase = require('./score-platform-base.step')
class ScoreTonghuashunStep extends ScorePlatformBase {
  get name() { return 'score-tonghuashun' }
  get description() { return '同花顺内容质量评分' }
  get platformKey() { return 'tonghuashunItems' }
  get platformLabel() { return '同花顺' }
}
module.exports = ScoreTonghuashunStep

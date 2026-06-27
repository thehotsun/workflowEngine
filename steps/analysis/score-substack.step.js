'use strict'
const ScorePlatformBase = require('./score-platform-base.step')
class ScoreSubstackStep extends ScorePlatformBase {
  get name() { return 'score-substack' }
  get description() { return 'Substack Newsletter 质量评分' }
  get platformKey() { return 'substackItems' }
  get platformLabel() { return 'Substack' }
  get evalLanguage() { return 'en' }
}
module.exports = ScoreSubstackStep

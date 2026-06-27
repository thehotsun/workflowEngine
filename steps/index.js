'use strict'

const BaseStep = require('./base.step')
const ParallelStep = require('./flow-control/parallel.step')
const ConditionalStep = require('./flow-control/conditional.step')
const TransformStep = require('./processing/transform.step')
const NoopStep = require('./flow-control/noop.step')
const SkillProxyStep = require('./integration/skill-proxy.step')
const RagQueryStep = require('./integration/rag-query.step')
const TopicStep = require('./content/select-topic.step')
const HotspotStep = require('./content/hotspot.step')
const WriteStep = require('./content/write.step')
const PolishStep = require('./content/polish.step')
const PublishStep = require('./output/publish.step')
const GenerateTopicsStep = require('./processing/generate-topics.step')
const SelectTopicStep = require('./content/select-topic.step')
const ResearchStep = require('./analysis/research.step')
const ImageGenerateStep = require('./output/image-generate.step')
const FetchHotspotsStep = require('./collection/fetch-hotspots.step')
const RenderArticleStep = require('./output/render-article.step')
const PlatformPublishStep = require('./output/platform-publish.step')
const WebSearchStep = require('./integration/web-search.step')
const QuantReportStep = require('./analysis/quant-report.step')

// Financial Intel Steps
const CollectTwitterStep = require('./collection/collect-twitter.step')
const CollectDiscordStep = require('./collection/collect-discord.step')
const MergeDataStep = require('./processing/merge-data.step')
const ScorePlatformBase = require('./analysis/score-platform-base.step')
const ScoreRedditStep = require('./analysis/score-reddit.step')
const ScoreTwitterStep = require('./analysis/score-twitter.step')
const ScoreDiscordStep = require('./analysis/score-discord.step')
const ScoreQualityStep = require('./analysis/score-quality.step')
const MergeScoredStep = require('./processing/merge-scored.step')
const FilterThresholdStep = require('./processing/filter-threshold.step')
const FilterAndSummarizeStep = require('./processing/filter-and-summarize.step')
const AnalyzeFinanceStep = require('./analysis/analyze-finance.step')
const PublishIntelStep = require('./output/publish-intel.step')
const CollectRedditArcticStep = require('./collection/collect-reddit-arctic.step')
const CollectSeekingAlphaStep = require('./collection/collect-seeking-alpha.step')
const CollectSubstackStep = require('./collection/collect-substack.step')
const CollectEastmoneyStep = require('./collection/collect-eastmoney.step')
const DeduplicateStep = require('./processing/deduplicate.step')
const CollectXueqiuStep = require('./collection/collect-xueqiu.step')
const CollectTonghuashunStep = require('./collection/collect-tonghuashun.step')
const PushThresholdStep = require('./processing/push-threshold.step')
const ArchiveArticlesStep = require('./output/archive-articles.step')
const ScoreXueqiuStep = require('./analysis/score-xueqiu.step')
const ScoreTonghuashunStep = require('./analysis/score-tonghuashun.step')
const ScoreSeekingAlphaStep = require('./analysis/score-seeking-alpha.step')
const ScoreSubstackStep = require('./analysis/score-substack.step')
const ScoreEastmoneyStep = require('./analysis/score-eastmoney.step')
const CollectRedditBloggerStep = require('./blogger/collect-reddit-blogger.step')

const STEP_REGISTRY = {
  'parallel':            (def, deps) => new ParallelStep({ steps: def.steps, ...deps }),
  'conditional':         (def, deps) => new ConditionalStep(deps),
  'transform':           (def, deps) => new TransformStep(),
  'noop':                (def, deps) => new NoopStep(),
  'skill-proxy':         (def, deps) => new SkillProxyStep(),
  'rag-query':           (def, deps) => new RagQueryStep(),
  'topic':               (def, deps) => new TopicStep(),
  'hotspot':             (def, deps) => new HotspotStep(),
  'write':               (def, deps) => new WriteStep(),
  'polish':              (def, deps) => new PolishStep(),
  'publish':             (def, deps) => new PublishStep(),
  'generate-topics':     (def, deps) => new GenerateTopicsStep(),
  'select-topic':        (def, deps) => new SelectTopicStep(),
  'research':            (def, deps) => new ResearchStep(),
  'image-generate':      (def, deps) => new ImageGenerateStep(),
  'fetch-hotspots':      (def, deps) => new FetchHotspotsStep(),
  'render-article':      (def, deps) => new RenderArticleStep(),
  'platform-publish':    (def, deps) => new PlatformPublishStep(),
  'web-search':          (def, deps) => new WebSearchStep(),
  'quant-report':        (def, deps) => new QuantReportStep(),

  // Financial Intel
  'collect-twitter':      (def, deps) => new CollectTwitterStep(),
  'collect-discord':      (def, deps) => new CollectDiscordStep(),
  'merge-data':           (def, deps) => new MergeDataStep(),
  'score-reddit':         (def, deps) => new ScoreRedditStep(),
  'score-twitter':        (def, deps) => new ScoreTwitterStep(),
  'score-discord':        (def, deps) => new ScoreDiscordStep(),
  'score-quality':        (def, deps) => new ScoreQualityStep(),
  'merge-scored':         (def, deps) => new MergeScoredStep(),
  'filter-threshold':     (def, deps) => new FilterThresholdStep(),
  'filter-and-summarize': (def, deps) => new FilterAndSummarizeStep(),
  'analyze-finance':      (def, deps) => new AnalyzeFinanceStep(),
  'collect-reddit-arctic':  (def, deps) => new CollectRedditArcticStep(),
  'collect-seeking-alpha':  (def, deps) => new CollectSeekingAlphaStep(),
  'collect-substack':       (def, deps) => new CollectSubstackStep(),
  'collect-eastmoney':      (def, deps) => new CollectEastmoneyStep(),
  'deduplicate':            (def, deps) => new DeduplicateStep(),
  'collect-xueqiu':         (def, deps) => new CollectXueqiuStep(),
  'collect-tonghuashun':    (def, deps) => new CollectTonghuashunStep(),
  'push-threshold':         (def, deps) => new PushThresholdStep(),
  'archive-articles':       (def, deps) => new ArchiveArticlesStep(),
  'score-xueqiu':           (def, deps) => new ScoreXueqiuStep(),
  'score-tonghuashun':      (def, deps) => new ScoreTonghuashunStep(),
  'score-seeking-alpha':    (def, deps) => new ScoreSeekingAlphaStep(),
  'score-substack':         (def, deps) => new ScoreSubstackStep(),
  'score-eastmoney':        (def, deps) => new ScoreEastmoneyStep(),
  'publish-intel':        (def, deps) => new PublishIntelStep(),

  // Blogger
  'collect-reddit-blogger': (def, deps) => new CollectRedditBloggerStep(),
}

function buildStep(stepDef, deps = {}) {
  const builder = STEP_REGISTRY[stepDef.type]
  if (!builder) throw new Error(`Unknown step type: "${stepDef.type}". Registered: ${Object.keys(STEP_REGISTRY).join(', ')}`)
  return builder(stepDef, deps)
}

function getStepCatalog() {
  const CATALOG_DEPS = { engine: null, workflow: null, conversation: null }
  return Object.keys(STEP_REGISTRY).map((type) => {
    const step = STEP_REGISTRY[type]({ type, steps: [] }, CATALOG_DEPS)
    return {
      type,
      description: step.description,
      category: step.category,
      requires: step.requires,
      provides: step.provides,
      retryable: step.retryable,
      timeout: step.timeout,
    }
  })
}

function registerStep(type, builder) {
  if (STEP_REGISTRY[type]) {
    throw new Error(`Step type "${type}" is already registered. Use a unique type name.`)
  }
  STEP_REGISTRY[type] = builder
}

module.exports = { buildStep, registerStep, getStepCatalog, BaseStep }

'use strict'

const BaseStep = require('./base.step')
const ParallelStep = require('./parallel.step')
const ConditionalStep = require('./conditional.step')
const TransformStep = require('./transform.step')
const NoopStep = require('./noop.step')
const SkillProxyStep = require('./skill-proxy.step')
const RagQueryStep = require('./rag-query.step')
const TopicStep = require('./topic.step')
const HotspotStep = require('./hotspot.step')
const WriteStep = require('./write.step')
const PolishStep = require('./polish.step')
const PublishStep = require('./publish.step')

const STEP_REGISTRY = {
  'parallel':     (def, deps) => new ParallelStep({ steps: def.steps, ...deps }),
  'conditional':  (def, deps) => new ConditionalStep(deps),
  'transform':    (def, deps) => new TransformStep(),
  'noop':         (def, deps) => new NoopStep(),
  'skill-proxy':  (def, deps) => new SkillProxyStep(),
  'rag-query':    (def, deps) => new RagQueryStep(),
  'topic':        (def, deps) => new TopicStep(),
  'hotspot':      (def, deps) => new HotspotStep(),
  'write':        (def, deps) => new WriteStep(),
  'polish':       (def, deps) => new PolishStep(),
  'publish':      (def, deps) => new PublishStep(),
}

function buildStep(stepDef, deps = {}) {
  const builder = STEP_REGISTRY[stepDef.type]
  if (!builder) throw new Error(`Unknown step type: "${stepDef.type}". Registered: ${Object.keys(STEP_REGISTRY).join(', ')}`)
  return builder(stepDef, deps)
}

function registerStep(type, builder) {
  if (STEP_REGISTRY[type]) {
    throw new Error(`Step type "${type}" is already registered. Use a unique type name.`)
  }
  STEP_REGISTRY[type] = builder
}

module.exports = { buildStep, registerStep, BaseStep }

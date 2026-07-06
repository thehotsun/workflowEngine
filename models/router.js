'use strict'

const BailianModel = require('./bailian.model')
const OpenAICompatModel = require('./openai-compat.model')

// 路由表：taskType -> 使用哪个 model 实例的哪个能力
const ROUTING_TABLE = {
  embedding: 'bailian',
  writing:   'bailian',
  analysis:  'bailian',
  reasoning: 'bailian',
  fallback:  'bailian'
}

// 模型实例注册表
const _models = {}

function _init() {
  _models['bailian'] = new BailianModel()
  // 扩展其他模型（qwen3.7max, glm5.1 等，均通过阿里百炼调用）
  _models['qwen3.7max'] = new OpenAICompatModel({
    name: 'qwen3.7max',
    apiKey: process.env.BAILIAN_API_KEY,
    baseURL: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-max'
  })
  _models['glm5.1'] = new OpenAICompatModel({
    name: 'glm5.1',
    apiKey: process.env.BAILIAN_API_KEY,
    baseURL: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'glm-5.1'
  })
}

_init()

function route(taskType = 'fallback', options = {}) {
  // 支持 step config 覆盖模型：{ taskType: 'writing', model: 'qwen3.7max' }
  if (options.model) {
    const model = _models[options.model]
    if (!model) throw new Error(`Model not found: ${options.model}`)
    return model
  }
  const modelName = ROUTING_TABLE[taskType] || ROUTING_TABLE.fallback
  const model = _models[modelName]
  if (!model) throw new Error(`Model not found for task type: ${taskType}, model: ${modelName}`)
  return model
}

function getEmbedModel() {
  return _models[ROUTING_TABLE.embedding]
}

function registerModel(name, instance) {
  _models[name] = instance
}

function setRoute(taskType, modelName) {
  ROUTING_TABLE[taskType] = modelName
}

module.exports = { route, getEmbedModel, registerModel, setRoute }

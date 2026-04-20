'use strict'

const BailianModel = require('./bailian.model')
const OpenAICompatModel = require('./openai-compat.model')

// 路由表: taskType -> 使用哪个 model 实例的哪个能力
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
  // 扩展其他模型示例（取消注释并填入配置即可）:
  // _models['deepseek'] = new OpenAICompatModel({
  //   name: 'deepseek',
  //   apiKey: process.env.DEEPSEEK_API_KEY,
  //   baseURL: 'https://api.deepseek.com/v1',
  //   chatModel: 'deepseek-chat'
  // })
}

_init()

function route(taskType = 'fallback') {
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

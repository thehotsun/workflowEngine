'use strict'

const OpenAI = require('openai')
const BaseModel = require('./base.model')

/**
 * 兼容 OpenAI 格式的通用模型适配器
 * 适用于: DeepSeek, Qwen, 本地 Ollama 等任何兼容 OpenAI 接口的模型
 */
class OpenAICompatModel extends BaseModel {
  constructor({ name, apiKey, baseURL, chatModel, embedModel }) {
    super()
    this._name = name
    this.chatModel = chatModel
    this.embedModel = embedModel
    this.client = new OpenAI({ apiKey, baseURL })
  }

  get name() { return this._name }

  async chat(messages, options = {}) {
    const response = await this.client.chat.completions.create({
      model: options.model || this.chatModel,
      messages,
      temperature: options.temperature ?? 0.7
    })

    return {
      content: response.choices?.[0]?.message?.content || '',
      usage: response.usage || null
    }
  }

  async embedding(text) {
    if (!this.embedModel) throw new Error(`${this._name} has no embedModel configured`)
    const response = await this.client.embeddings.create({
      model: this.embedModel,
      input: text
    })

    return response.data?.[0]?.embedding || []
  }
}

module.exports = OpenAICompatModel

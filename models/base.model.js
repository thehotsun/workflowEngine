'use strict'

class BaseModel {
  get name() {
    throw new Error('Model must implement get name()')
  }

  async chat(messages, options = {}) {
    throw new Error('Model must implement chat(messages, options)')
  }

  async embedding(text) {
    throw new Error('Model must implement embedding(text)')
  }
}

module.exports = BaseModel

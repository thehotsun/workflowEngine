'use strict'

class WorkflowContext {
  constructor(initial = {}) {
    this.data = { ...initial }
  }

  get(key, defaultValue = undefined) {
    return this.data[key] !== undefined ? this.data[key] : defaultValue
  }

  set(key, value) {
    this.data[key] = value
    return value
  }

  delete(key) {
    delete this.data[key]
  }

  merge(patch = {}) {
    Object.assign(this.data, patch)
    return this.data
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key)
  }

  snapshot() {
    return new WorkflowContext(this.toJSON())
  }

  toJSON() {
    return { ...this.data }
  }
}

module.exports = WorkflowContext

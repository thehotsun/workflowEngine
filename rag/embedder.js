'use strict'

const { getEmbedModel } = require('../models/router')

async function embedding(text) {
  const model = getEmbedModel()
  return model.embedding(text)
}

async function embeddings(texts = []) {
  const model = getEmbedModel()
  if (typeof model.embeddings === 'function') {
    return model.embeddings(texts)
  }

  const results = []
  for (const text of texts) {
    results.push(await model.embedding(text))
  }
  return results
}

module.exports = { embedding, embeddings }

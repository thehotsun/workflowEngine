'use strict'

const { getDb } = require('../db')
const { v4: uuidv4 } = require('uuid')

function enqueueDlq({ runId, stepName, error, input, retryCount }) {
  const id = `dlq_${uuidv4().replace(/-/g, '')}`
  getDb().prepare(`
    INSERT INTO dlq (id, run_id, step_name, error, input_json, retry_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId || null, stepName || null, error || 'Unknown error', JSON.stringify(input || {}), retryCount || 0, Date.now())
  return id
}

module.exports = { enqueueDlq }

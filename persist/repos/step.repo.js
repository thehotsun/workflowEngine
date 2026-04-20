'use strict'

const { getDb } = require('../db')
const { v4: uuidv4 } = require('uuid')

function createStepRun({ runId, stepName, stepIndex, input = {} }) {
  const id = `step_${uuidv4().replace(/-/g, '')}`
  getDb().prepare(`
    INSERT INTO step_runs
      (id, run_id, step_name, step_index, status, input_json)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, runId, stepName, stepIndex, JSON.stringify(input))
  return id
}

function updateStepRun(id, patch = {}) {
  getDb().prepare(`
    UPDATE step_runs
    SET status = COALESCE(?, status),
        output_json = COALESCE(?, output_json),
        error = COALESCE(?, error),
        retry_count = COALESCE(?, retry_count),
        duration_ms = COALESCE(?, duration_ms),
        token_used = COALESCE(?, token_used),
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at)
    WHERE id = ?
  `).run(
    patch.status || null,
    patch.output ? JSON.stringify(patch.output) : null,
    patch.error || null,
    patch.retryCount !== undefined ? patch.retryCount : null,
    patch.durationMs !== undefined ? patch.durationMs : null,
    patch.tokenUsed !== undefined ? patch.tokenUsed : null,
    patch.startedAt || null,
    patch.finishedAt || null,
    id
  )
}

function getCompletedStepRuns(runId) {
  return getDb().prepare(`
    SELECT * FROM step_runs WHERE run_id = ? AND status = 'done' ORDER BY step_index ASC
  `).all(runId)
}

module.exports = { createStepRun, updateStepRun, getCompletedStepRuns }

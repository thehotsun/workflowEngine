'use strict'

const { getDb } = require('../db')
const { v4: uuidv4 } = require('uuid')

function createRun({ workflowId, conversationId, eventId, context = {} }) {
  const db = getDb()
  const id = `run_${uuidv4().replace(/-/g, '')}`
  const now = Date.now()
  db.prepare(`
    INSERT INTO workflow_runs
      (id, workflow_id, conversation_id, event_id, status, context_json, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, workflowId, conversationId || null, eventId || null, JSON.stringify(context), now)
  return id
}

function updateRunStatus(id, status, patch = {}) {
  const db = getDb()
  db.prepare(`
    UPDATE workflow_runs
    SET status = ?,
        current_step = COALESCE(?, current_step),
        error = COALESCE(?, error),
        context_json = COALESCE(?, context_json),
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at)
    WHERE id = ?
  `).run(
    status,
    patch.currentStep || null,
    patch.error || null,
    patch.context ? JSON.stringify(patch.context) : null,
    patch.startedAt || null,
    patch.finishedAt || null,
    id
  )
}

function getRunById(id) {
  return getDb().prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(id)
}

function getRecoverableRuns() {
  return getDb().prepare(`
    SELECT * FROM workflow_runs WHERE status IN ('pending', 'running', 'retrying') ORDER BY created_at ASC
  `).all()
}

/**
 * 查找指定 channel 的等待中 workflow run
 * 用于用户回复后恢复执行
 */
function getWaitingRun(channelId) {
  return getDb().prepare(`
    SELECT * FROM workflow_runs WHERE status = 'waiting' ORDER BY created_at DESC LIMIT 1
  `).get()
}

/**
 * 查找指定 channel 的等待中 workflow run（按 channelId 匹配）
 */
function getWaitingRunByChannel(channelId) {
  return getDb().prepare(`
    SELECT wr.* FROM workflow_runs wr
    JOIN conversations c ON c.id = wr.conversation_id
    WHERE wr.status = 'waiting' AND c.channel_id = ?
    ORDER BY wr.created_at DESC LIMIT 1
  `).get(channelId)
}

module.exports = { createRun, updateRunStatus, getRunById, getRecoverableRuns, getWaitingRun, getWaitingRunByChannel }

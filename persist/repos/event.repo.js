'use strict'

const { getDb } = require('../db')
const { v4: uuidv4 } = require('uuid')

function createEvent(event) {
  const db = getDb()
  const now = Date.now()

  if (event.source && event.sourceEventId) {
    const existing = db.prepare(`
      SELECT id FROM event_inbox WHERE source = ? AND source_event_id = ?
    `).get(event.source, event.sourceEventId)

    if (existing) return existing.id
  }

  const id = event.id || `evt_${uuidv4().replace(/-/g, '')}`
  db.prepare(`
    INSERT INTO event_inbox
      (id, source, source_event_id, event_type, payload_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, event.source, event.sourceEventId || null, event.eventType, JSON.stringify(event.payload), now)
  return id
}

function getPendingEvents(limit = 10) {
  return getDb().prepare(`
    SELECT * FROM event_inbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
  `).all(limit)
}

function markProcessing(id, runId) {
  getDb().prepare(`
    UPDATE event_inbox SET status = 'processing', workflow_run_id = ? WHERE id = ?
  `).run(runId, id)
}

function markDone(id) {
  getDb().prepare(`
    UPDATE event_inbox SET status = 'done', processed_at = ? WHERE id = ?
  `).run(Date.now(), id)
}

function markFailed(id, error) {
  const errorText = error ? String(error).slice(0, 500) : 'unknown error'
  const db = getDb()

  // 事件表本身无 error 字段，先把失败原因写入关联 run 方便排障
  const row = db.prepare(`SELECT workflow_run_id FROM event_inbox WHERE id = ?`).get(id)
  if (row?.workflow_run_id) {
    db.prepare(`
      UPDATE workflow_runs
      SET error = COALESCE(?, error), finished_at = COALESCE(finished_at, ?)
      WHERE id = ?
    `).run(errorText, Date.now(), row.workflow_run_id)
  }

  db.prepare(`
    UPDATE event_inbox SET status = 'failed', processed_at = ? WHERE id = ?
  `).run(Date.now(), id)
}

module.exports = { createEvent, getPendingEvents, markProcessing, markDone, markFailed }

'use strict'

const { getDb } = require('../db')
const { v4: uuidv4 } = require('uuid')

function safeParseContext(contextJson) {
  if (!contextJson) return {}
  try {
    const parsed = JSON.parse(contextJson)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

function getOrCreateConversation({ source, channelId, userId }) {
  const db = getDb()
  const existing = db.prepare(`
    SELECT * FROM conversations WHERE source = ? AND channel_id = ?
  `).get(source, channelId)

  if (existing) return existing

  const id = `conv_${uuidv4().replace(/-/g, '')}`
  const now = Date.now()
  db.prepare(`
    INSERT INTO conversations (id, source, channel_id, user_id, context_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, source, channelId, userId || null, JSON.stringify({}), now, now)

  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id)
}

function updateConversation(id, patch = {}) {
  const db = getDb()
  const existing = db.prepare('SELECT context_json FROM conversations WHERE id = ?').get(id)
  const currentContext = safeParseContext(existing?.context_json)
  const mergedContext = patch.context ? { ...currentContext, ...patch.context } : null

  db.prepare(`
    UPDATE conversations
    SET last_run_id = COALESCE(?, last_run_id),
        context_json = COALESCE(?, context_json),
        updated_at = ?
    WHERE id = ?
  `).run(
    patch.lastRunId || null,
    mergedContext ? JSON.stringify(mergedContext) : null,
    Date.now(),
    id
  )
}

function appendConversationHistory(id, item, maxItems = 10) {
  const db = getDb()
  const existing = db.prepare('SELECT context_json FROM conversations WHERE id = ?').get(id)
  const context = safeParseContext(existing?.context_json)
  const history = Array.isArray(context.history) ? context.history : []
  const nextHistory = [...history, item].slice(-maxItems)

  db.prepare(`
    UPDATE conversations
    SET context_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify({ ...context, history: nextHistory }),
    Date.now(),
    id
  )
}

module.exports = { getOrCreateConversation, updateConversation, appendConversationHistory }

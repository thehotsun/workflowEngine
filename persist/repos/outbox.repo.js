'use strict'

const { getDb } = require('../db')
const { v4: uuidv4 } = require('uuid')

function enqueueMessage({ runId, target = 'openclaw', channelId, content }) {
  const id = `msg_${uuidv4().replace(/-/g, '')}`
  getDb().prepare(`
    INSERT INTO message_outbox (id, run_id, target, channel_id, content, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, runId || null, target, channelId, content, Date.now())
  return id
}

function getPendingMessages(limit = 20) {
  return getDb().prepare(`
    SELECT * FROM message_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
  `).all(limit)
}

function markSending(id, retryCount) {
  getDb().prepare(`
    UPDATE message_outbox SET status = 'sending', retry_count = ? WHERE id = ?
  `).run(retryCount, id)
}

function markSent(id) {
  getDb().prepare(`
    UPDATE message_outbox SET status = 'sent', sent_at = ? WHERE id = ?
  `).run(Date.now(), id)
}

function markMessageRetry(id, retryCount) {
  getDb().prepare(`
    UPDATE message_outbox SET status = 'pending', retry_count = ? WHERE id = ?
  `).run(retryCount, id)
}

function markMessageFailed(id, retryCount) {
  getDb().prepare(`
    UPDATE message_outbox SET status = 'failed', retry_count = ? WHERE id = ?
  `).run(retryCount, id)
}

/**
 * 启动时将超时卡死的 sending 消息重置为 pending，防止进程崩溃后消息永久丢失。
 * @param {number} staleAfterMs 超过此毫秒数仍处于 sending 状态的消息视为卡死（默认 10 分钟）
 * @returns {number} 重置条数
 */
function resetStaleSendingMessages(staleAfterMs = 10 * 60 * 1000) {
  const cutoff = Date.now() - staleAfterMs
  const result = getDb().prepare(`
    UPDATE message_outbox
    SET status = 'pending'
    WHERE status = 'sending' AND created_at < ?
  `).run(cutoff)
  return result.changes
}

module.exports = {
  enqueueMessage,
  getPendingMessages,
  markSending,
  markSent,
  markMessageRetry,
  markMessageFailed,
  resetStaleSendingMessages
}

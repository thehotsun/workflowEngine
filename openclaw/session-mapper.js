'use strict'

const { getOrCreateConversation } = require('../persist/repos/conversation.repo')

/**
 * 将 OpenClaw session 信息映射到引擎内部的 conversation
 */
function mapToConversation({ source, channelId, userId }) {
  return getOrCreateConversation({ source, channelId, userId })
}

function getConversationHistory(conversation, limit = 10) {
  if (!conversation?.context_json) return []
  try {
    const parsed = JSON.parse(conversation.context_json)
    if (!Array.isArray(parsed?.history)) return []
    return parsed.history.slice(-limit)
  } catch (_) {
    return []
  }
}

module.exports = { mapToConversation, getConversationHistory }

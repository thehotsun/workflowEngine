'use strict'

/**
 * 从 OpenClaw invokeTool 响应中提取搜索结果
 * 
 * OpenClaw 返回格式：
 * {
 *   ok: true,
 *   result: {
 *     content: [
 *       { type: 'text', text: '{"results": [...]}' }
 *     ]
 *   }
 * }
 */
function extractSearchResults(response) {
  try {
    // 格式 1：直接返回 results 数组
    if (Array.isArray(response?.results)) {
      return response.results
    }

    // 格式 2：OpenClaw invokeTool 响应
    const textContent = response?.result?.content?.[0]?.text
    if (textContent) {
      const parsed = JSON.parse(textContent)
      return parsed.results || []
    }

    return []
  } catch (e) {
    return []
  }
}

module.exports = { extractSearchResults }

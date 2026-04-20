'use strict'

/**
 * 将 Markdown 内容按标题语义分块
 * 目标：400~600 token/chunk，不足的段落向上合并，超过的强制切分
 */
function chunkMarkdown(content, { targetTokens = 500, minTokens = 100, maxTokens = 800 } = {}) {
  const lines = content.split('\n')
  const chunks = []
  let currentHeading = null
  let currentLines = []

  function flushChunk() {
    const text = currentLines.join('\n').trim()
    if (!text) return
    const estimated = estimateTokens(text)

    if (estimated > maxTokens) {
      // 超过上限，按段落切分
      const paras = text.split(/\n{2,}/)
      let buf = []
      for (const para of paras) {
        buf.push(para)
        if (estimateTokens(buf.join('\n\n')) >= targetTokens) {
          chunks.push({ heading: currentHeading, content: buf.join('\n\n').trim() })
          buf = []
        }
      }
      if (buf.length && estimateTokens(buf.join('\n\n')) >= minTokens) {
        chunks.push({ heading: currentHeading, content: buf.join('\n\n').trim() })
      } else if (buf.length && chunks.length) {
        // 太短，合并到上一个 chunk
        chunks[chunks.length - 1].content += '\n\n' + buf.join('\n\n').trim()
      }
    } else if (estimated < minTokens && chunks.length > 0) {
      // 太短，合并到上一个 chunk
      chunks[chunks.length - 1].content += '\n\n' + text
    } else {
      chunks.push({ heading: currentHeading, content: text })
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      flushChunk()
      currentHeading = headingMatch[2].trim()
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flushChunk()

  return chunks.map((chunk, i) => ({
    ...chunk,
    chunkIndex: i,
    tokenCount: estimateTokens(chunk.content)
  }))
}

function estimateTokens(text) {
  // 简单估算：中文按1.5字/token，英文按4字符/token
  const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const en = text.length - cn
  return Math.ceil(cn / 1.5 + en / 4)
}

module.exports = { chunkMarkdown }

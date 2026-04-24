'use strict'

/**
 * 将 Markdown 内容按标题语义分块
 * 目标：400~600 token/chunk，不足的段落向上合并，超过的强制切分
 */
function chunkMarkdown(content, { targetTokens = 500, minTokens = 100, maxTokens = 800, hardMaxTokens = 6500 } = {}) {
  const lines = content.split('\n')
  const chunks = []
  let currentHeading = null
  let currentLines = []

  // 将文本安全地推入 chunks，超过硬上限时优先按自然边界切分，最后按字符兜底
  function pushSafe(heading, text) {
    if (estimateTokens(text) <= hardMaxTokens) {
      chunks.push({ heading, content: text })
      return
    }

    for (const slice of splitByTokenLimit(text, hardMaxTokens)) {
      chunks.push({ heading, content: slice })
    }
  }

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
          pushSafe(currentHeading, buf.join('\n\n').trim())
          buf = []
        }
      }
      if (buf.length) {
        const remaining = buf.join('\n\n').trim()
        if (estimateTokens(remaining) >= minTokens) {
          pushSafe(currentHeading, remaining)
        } else if (chunks.length) {
          // 太短，合并到上一个 chunk（检查合并后不超过硬上限）
          const merged = chunks[chunks.length - 1].content + '\n\n' + remaining
          if (estimateTokens(merged) <= hardMaxTokens) {
            chunks[chunks.length - 1].content = merged
          } else {
            pushSafe(currentHeading, remaining)
          }
        }
      }
    } else if (estimated < minTokens && chunks.length > 0) {
      // 太短，合并到上一个 chunk（检查合并后不超过硬上限）
      const merged = chunks[chunks.length - 1].content + '\n\n' + text
      if (estimateTokens(merged) <= hardMaxTokens) {
        chunks[chunks.length - 1].content = merged
      } else {
        pushSafe(currentHeading, text)
      }
    } else {
      pushSafe(currentHeading, text)
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

function splitByTokenLimit(text, hardMaxTokens) {
  const result = []
  let rest = text.trim()

  while (rest && estimateTokens(rest) > hardMaxTokens) {
    const slice = takeSafeSlice(rest, hardMaxTokens).trim()
    if (!slice) break
    result.push(slice)
    rest = rest.slice(slice.length).trim()
  }

  if (rest) result.push(rest)
  return result
}

function takeSafeSlice(text, hardMaxTokens) {
  const charLimit = Math.max(1, Math.floor(hardMaxTokens * 1.5))
  if (text.length <= charLimit) return text

  const window = text.slice(0, charLimit)
  const boundaries = [
    /\n{2,}(?![\s\S]*\n{2,})/,
    /[。！？；](?![\s\S]*[。！？；])/,
    /\n(?![\s\S]*\n)/,
    /[.?!;](?![\s\S]*[.?!;])/,
    /\s(?![\s\S]*\s)/
  ]

  for (const boundary of boundaries) {
    const match = window.match(boundary)
    if (match && match.index > charLimit * 0.5) {
      return window.slice(0, match.index + match[0].length)
    }
  }

  return window
}

function estimateTokens(text) {
  // 简单估算：中文按1.5字/token，英文按4字符/token
  const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const en = text.length - cn
  return Math.ceil(cn / 1.5 + en / 4)
}

module.exports = { chunkMarkdown }

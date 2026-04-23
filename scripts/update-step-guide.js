#!/usr/bin/env node
/**
 * scripts/update-step-guide.js
 *
 * 用途：每次新增 / 修改 Step 后执行此脚本，自动把最新的 Catalog JSON 同步到
 *       steps/STEP_GUIDE.md 的 §16 节中，保持文档与代码单一真相一致。
 *
 * 用法：
 *   node scripts/update-step-guide.js
 *
 * 触发时机（任选其一）：
 *   - 手动：新增 step 并注册后运行一次
 *   - package.json scripts 中加 "guide": "node scripts/update-step-guide.js"
 *   - pre-commit hook 中调用（推荐）
 *
 * 依赖：
 *   - 仅依赖 Node.js 内置模块 + 项目已有 dotenv（脚本内 mock 掉依赖项，不需要真实 env）
 *
 * 原理：
 *   1. 以"轻量 mock"的方式屏蔽运行时依赖（DB / LLM / QQ Bot），只提取 step 元数据
 *   2. 调用 getStepCatalog() 生成最新 JSON
 *   3. 将 STEP_GUIDE.md 中 §16 的 CATALOG_JSON 块替换为最新版本
 */

'use strict'

const fs = require('fs')
const path = require('path')
const Module = require('module')

// ── 1. Mock 运行时依赖，避免加载 step 时触发 DB / 网络初始化 ──────────────
const ROOT = path.resolve(__dirname, '..')

// 拦截 require，对有副作用的模块返回空 mock
const originalLoad = Module._load.bind(Module)
Module._load = function (request, parent, isMain) {
  // dotenv
  if (request === 'dotenv') {
    return { config: () => {} }
  }
  // openai sdk（models/bailian.model.js 依赖）
  if (request === 'openai') {
    return function OpenAI() { return {} }
  }
  // models/router.js（topic/write/polish 等 step 顶层依赖）
  if (request.includes('models/router') || request.includes('models\\router')) {
    return { route: () => ({ chat: async () => ({ content: '', usage: {} }) }) }
  }
  // config/index.js — 返回空配置对象，避免读取 .env
  if (request === path.join(ROOT, 'config') || request === path.join(ROOT, 'config', 'index.js') || request === '../config') {
    return new Proxy({}, { get: () => undefined })
  }
  // openclaw/client.js — SkillProxyStep 依赖它，mock 掉
  if (
    request.includes('openclaw/client') ||
    request.includes('openclaw\\client')
  ) {
    return { invokeTool: async () => ({}) }
  }
  // rag/retriever.js — RagQueryStep 依赖它
  if (request.includes('rag/retriever') || request.includes('rag\\retriever')) {
    return { retrieve: async () => [] }
  }
  // persist repos — PublishStep 依赖
  if (
    request.includes('persist/repos') ||
    request.includes('persist\\repos') ||
    request.includes('outbox.repo') ||
    request.includes('outbox-worker')
  ) {
    return { enqueueMessage: () => 0, outboxEmitter: { emit: () => {} } }
  }
  // pino logger
  if (request === 'pino' || request.includes('utils/logger') || request.includes('utils\\logger')) {
    const noop = () => noop
    const logger = new Proxy({}, { get: () => noop })
    return logger
  }
  return originalLoad(request, parent, isMain)
}

// ── 2. 加载 steps/index.js 并获取 catalog ─────────────────────────────────
const { getStepCatalog } = require(path.join(ROOT, 'steps', 'index.js'))
const catalog = getStepCatalog()

// ── 3. 恢复 Module._load（非必需，但保持整洁）──────────────────────────────
Module._load = originalLoad

// ── 4. 格式化 catalog JSON（4空格缩进，标准 JSON） ──────────────────────────
const catalogJson = JSON.stringify(catalog, null, 2)

// ── 5. 读取 STEP_GUIDE.md ─────────────────────────────────────────────────
const guidePath = path.join(ROOT, 'steps', 'STEP_GUIDE.md')
let content = fs.readFileSync(guidePath, 'utf-8')

// ── 6. 替换标记区块 ───────────────────────────────────────────────────────
//
// 约定：STEP_GUIDE.md §16 中使用以下标记包裹 catalog JSON 块：
//
//   <!-- CATALOG_JSON_START -->
//   ```json
//   [ ... ]
//   ```
//   <!-- CATALOG_JSON_END -->
//
// 脚本只替换这对标记之间的内容，不影响外部文字。
const START_MARKER = '<!-- CATALOG_JSON_START -->'
const END_MARKER   = '<!-- CATALOG_JSON_END -->'

const startIdx = content.indexOf(START_MARKER)
const endIdx   = content.indexOf(END_MARKER)

if (startIdx === -1 || endIdx === -1) {
  console.error('❌  未找到标记 <!-- CATALOG_JSON_START --> 或 <!-- CATALOG_JSON_END -->，请检查 STEP_GUIDE.md')
  process.exit(1)
}

const before = content.slice(0, startIdx + START_MARKER.length)
const after  = content.slice(endIdx)

const newBlock = `\n\`\`\`json\n${catalogJson}\n\`\`\`\n`

const newContent = before + newBlock + after

// ── 7. 更新日期行 ─────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10)
const updatedContent = newContent.replace(
  /\*文档最后更新：\d{4}-\d{2}-\d{2}\*/,
  `*文档最后更新：${today}*`
)

// ── 8. 写回文件 ───────────────────────────────────────────────────────────
fs.writeFileSync(guidePath, updatedContent, 'utf-8')

console.log(`✅  STEP_GUIDE.md 已更新（${catalog.length} 个 step），日期 ${today}`)
catalog.forEach(s => {
  const req = s.requires.length ? s.requires.join(', ') : '—'
  const prov = s.provides.length ? s.provides.join(', ') : '—'
  console.log(`   ${s.type.padEnd(18)} [${s.category}]  requires:[${req}]  provides:[${prov}]`)
})

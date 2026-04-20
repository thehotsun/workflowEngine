'use strict'

const path = require('path')
const dotenv = require('dotenv')

dotenv.config()

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',

  BAILIAN_API_KEY: process.env.BAILIAN_API_KEY || '',
  BAILIAN_BASE_URL: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  BAILIAN_CHAT_MODEL: process.env.BAILIAN_CHAT_MODEL || 'qwen-plus',
  BAILIAN_EMBED_MODEL: process.env.BAILIAN_EMBED_MODEL || 'text-embedding-v4',

  OPENCLAW_BASE_URL: process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
  OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || '',
  OPENCLAW_DEFAULT_SESSION_KEY: process.env.OPENCLAW_DEFAULT_SESSION_KEY || '',
  OPENCLAW_WEBHOOK_SECRET: process.env.OPENCLAW_WEBHOOK_SECRET || '',
  OPENCLAW_MESSAGE_TOOL: process.env.OPENCLAW_MESSAGE_TOOL || 'message',
  OPENCLAW_MESSAGE_ACTION: process.env.OPENCLAW_MESSAGE_ACTION || 'send',
  OPENCLAW_MESSAGE_TARGET_ARG: process.env.OPENCLAW_MESSAGE_TARGET_ARG || 'target',
  OPENCLAW_MESSAGE_CONTENT_ARG: process.env.OPENCLAW_MESSAGE_CONTENT_ARG || 'content',
  OPENCLAW_MESSAGE_TARGET_PREFIX: process.env.OPENCLAW_MESSAGE_TARGET_PREFIX || '',
  OPENCLAW_MESSAGE_CHANNEL: process.env.OPENCLAW_MESSAGE_CHANNEL || 'qqbot',
  OPENCLAW_ACCOUNT_ID: process.env.OPENCLAW_ACCOUNT_ID || '',

  SCHEDULER_CHANNEL_ID: process.env.SCHEDULER_CHANNEL_ID || 'schedule',
  SCHEDULER_CRON: process.env.SCHEDULER_CRON || '0 8 * * *',
  SCHEDULER_TEXT: process.env.SCHEDULER_TEXT || '定时内容生成任务',

  DB_PATH: process.env.DB_PATH || path.join(process.cwd(), 'data', 'engine.db'),
  KNOWLEDGE_DIR: process.env.KNOWLEDGE_DIR || path.join(process.cwd(), 'knowledge'),

  MAX_CONCURRENT_RUNS: Number(process.env.MAX_CONCURRENT_RUNS || 5),
  MAX_CONCURRENT_LLM_CALLS: Number(process.env.MAX_CONCURRENT_LLM_CALLS || 3),
  MAX_CONCURRENT_EMBED_CALLS: Number(process.env.MAX_CONCURRENT_EMBED_CALLS || 5),

  CIRCUIT_BREAKER_THRESHOLD: Number(process.env.CIRCUIT_BREAKER_THRESHOLD || 5),
  CIRCUIT_BREAKER_RESET_MS: Number(process.env.CIRCUIT_BREAKER_RESET_MS || 30000),
}

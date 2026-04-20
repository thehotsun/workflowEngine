'use strict'

const cron = require('node-cron')
const { createEvent } = require('../persist/repos/event.repo')
const { getDb } = require('../persist/db')
const logger = require('../utils/logger')
const {
  SCHEDULER_CHANNEL_ID,
  SCHEDULER_CRON,
  SCHEDULER_TEXT
} = require('../config')

function startScheduler() {
  cron.schedule(SCHEDULER_CRON, () => {
    const eventId = createEvent({
      source: 'schedule',
      sourceEventId: `schedule_${Date.now()}`,
      eventType: 'schedule',
      payload: {
        source: 'schedule',
        sourceEventId: `schedule_${Date.now()}`,
        triggerType: 'schedule',
        text: SCHEDULER_TEXT,
        channelId: SCHEDULER_CHANNEL_ID,
        userId: 'system'
      }
    })

    logger.info({ eventId, channelId: SCHEDULER_CHANNEL_ID }, 'Scheduled event created')
  })

  // 每天凌晨 3 点执行 WAL checkpoint，防止 WAL 文件无限增长
  cron.schedule('0 3 * * *', () => {
    try {
      getDb().pragma('wal_checkpoint(TRUNCATE)')
      logger.info('WAL checkpoint completed')
    } catch (err) {
      logger.error({ err: err.message }, 'WAL checkpoint failed')
    }
  })
}

module.exports = { startScheduler }

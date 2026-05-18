'use strict'

/**
 * 量化分析报告推送流程
 *
 * 接收量化系统生成的分析报告，推送到 QQ 频道。
 *
 * 触发方式：
 *   POST /events/manual
 *   { "text": "报告内容", "channelId": "qqbot:c2c:xxx" }
 *
 * 流程：
 *   1. 接收报告文本
 *   2. 推送到指定 QQ 频道
 */

module.exports = {
  id: 'quant_report',
  name: '量化报告推送',

  config: {
    // 默认目标频道（可通过 event.context 覆盖）
    targetChannelId: 'qqbot:c2c:671E406CE85706E91F0CF251BD7D8177',
  },

  trigger: {
    // 仅匹配手动触发的事件（通过 /events/manual webhook）
    source: 'manual',
    // 也支持手动触发
    manual: true,
  },

  steps: [
    // 推送报告
    {
      type: 'quant-report',
      input: (ctx) => ({
        report: ctx.get('input') || ctx.get('event')?.text || '',
        channelId: ctx.get('event')?.channelId || ctx.config.targetChannelId,
      }),
      output: 'pushResult',
    },
  ],
}

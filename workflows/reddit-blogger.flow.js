'use strict'

module.exports = {
  id: 'reddit_blogger',
  enabled: true,
  name: 'Reddit 博主数据采集',

  config: {},

  trigger: {
    match: (text) => {
      const t = text.trim()
      return t.startsWith('reddit ') || t.startsWith('Reddit ')
    },
  },

  steps: [
    {
      type: 'collect-reddit-blogger',
      output: 'bloggerData',
    },
  ],

  onError: 'pause',
}

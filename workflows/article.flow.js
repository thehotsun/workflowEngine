'use strict'

module.exports = {
  id: 'article_flow',
  name: '公众号文章生成',
  trigger: {
    type: 'message',
    match: /写文章|写公众号|帮我写|生成文章/
  },
  steps: [
    {
      type: 'topic'
    },
    {
      type: 'rag-query',
      input: ctx => ({ query: ctx.get('topic') }),
      output: 'ragResults',
      topK: 5
    },
    {
      type: 'conditional',
      condition: (ctx) => Array.isArray(ctx.get('ragResults')) && ctx.get('ragResults').length === 0,
      ifTrue: {
        type: 'skill-proxy',
        skill: 'web-search',
        input: ctx => ({ query: ctx.get('topic') }),
        output: 'searchResults',
        timeout: 15000
      },
      ifFalse: {
        type: 'noop'
      }
    },
    {
      type: 'write'
    },
    {
      type: 'polish'
    },
    {
      type: 'publish'
    }
  ],
  onError: 'notify-and-dlq'
}

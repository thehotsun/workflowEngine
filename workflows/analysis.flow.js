'use strict'

/**
 * analysis.flow.js — 热点分析流程
 *
 * 触发：用户发送分析类请求（热点/趋势/行业分析等关键词）
 *
 * 流程：
 *  1. topic      — 提炼分析主题
 *  2. rag-query  — 知识库检索背景资料
 *  3. conditional
 *       ragResults 为空 → skill-proxy(web-search) 补充最新资讯
 *       ragResults 有内容 → noop
 *  4. hotspot    — 从搜索/知识库结果中提炼热点话题与角度
 *  5. write      — 基于热点与资料生成分析报告
 *  6. polish     — 润色
 *  7. publish    — 发送结果
 */
module.exports = {
  id: 'analysis_flow',
  name: '热点分析报告生成',

  trigger: {
    type: 'message',
    match: /分析|热点|趋势|行业报告|市场洞察|帮我分析|帮我看看/
  },

  steps: [
    // Step 1: 提炼主题
    { type: 'topic' },

    // Step 2: 知识库检索
    {
      type: 'rag-query',
      requires: ['topic'],
      input: ctx => ({ query: ctx.get('topic') }),
      output: 'ragResults',
      topK: 5
    },

    // Step 3: 若知识库无结果，走 web-search 补充
    {
      type: 'conditional',
      condition: ctx => {
        const r = ctx.get('ragResults')
        return !Array.isArray(r) || r.length === 0
      },
      ifTrue: {
        type: 'skill-proxy',
        skill: 'web-search',
        input: ctx => ({ 
          query: ctx.get('topic'),
          count: 5  // 返回 5 条搜索结果
        }),
        output: 'searchResults',
        timeout: 20_000
      },
      ifFalse: { type: 'noop' }
    },

    // Step 4: 热点提炼
    { type: 'hotspot' },

    // Step 5: 生成分析报告
    { type: 'write' },

    // Step 6: 润色
    { type: 'polish' },

    // Step 7: 发布
    { type: 'publish' }
  ],

  onError: 'notify-and-dlq'
}

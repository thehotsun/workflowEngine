# Web-Search 使用文档

## 📚 概述

工作流引擎现已集成 OpenClaw 的 `web-search` 能力，可以在知识库检索失败时自动从互联网搜索最新资讯。

---

## 🔧 配置要求

### 1. OpenClaw Gateway 配置

确保 `~/.openclaw/openclaw.json` 中配置了搜索提供商：

```json
{
  "plugins": {
    "entries": {
      "brave": {
        "config": {
          "webSearch": {
            "apiKey": "YOUR_BRAVE_API_KEY",
            "mode": "web"
          }
        }
      }
    }
  },
  "tools": {
    "web": {
      "search": {
        "provider": "brave",
        "maxResults": 5,
        "timeoutSeconds": 30
      }
    }
  }
}
```

### 2. 支持的搜索提供商

- ✅ **Brave Search**（推荐，需要 API Key）
- ✅ **DuckDuckGo**（免费，无需配置）
- ✅ **SearXNG**（自建）
- ✅ **Google/Bing**（需要 API）

---

## 📋 使用方式

### 方式 1：使用 `web-search` 步骤（推荐）

```javascript
{
  type: 'web-search',
  query: ctx => ctx.get('topic'),
  output: 'searchResults',
  count: 5,           // 返回结果数（1-10）
  freshness: 'week',  // 可选：'day' | 'week' | 'month' | 'year'
  timeout: 20000
}
```

### 方式 2：使用 `skill-proxy` 步骤（兼容旧代码）

```javascript
{
  type: 'skill-proxy',
  skill: 'web-search',
  input: ctx => ({ 
    query: ctx.get('topic'),
    count: 5 
  }),
  output: 'searchResults',
  timeout: 20000
}
```

---

## 🔄 自动降级逻辑

工作流中已配置智能降级：

```javascript
// 1. 先尝试知识库检索
{
  type: 'rag-query',
  input: ctx => ({ query: ctx.get('topic') }),
  output: 'ragResults'
}

// 2. 如果知识库没结果，自动走 web-search
{
  type: 'conditional',
  condition: ctx => !ctx.get('ragResults')?.length,
  ifTrue: {
    type: 'web-search',
    query: ctx => ctx.get('topic'),
    output: 'searchResults'
  },
  ifFalse: { type: 'noop' }
}
```

---

## 📊 搜索结果格式

```javascript
[
  {
    title: "文章标题",
    url: "https://example.com/article",
    snippet: "摘要内容...",
    source: "来源网站",
    publishedAt: "2026-04-24",
    raw: { /* 原始数据 */ }
  }
]
```

---

## 🎯 实际应用示例

### 热点分析流程 (`analysis.flow.js`)

```javascript
// 当用户说"分析一下最近的 AI 趋势"
{
  type: 'web-search',
  query: ctx => ctx.get('topic'),  // "AI 趋势"
  output: 'searchResults',
  count: 5
}
```

### 公众号文章流程 (`article.flow.js`)

```javascript
// 当知识库没有相关素材时
{
  type: 'conditional',
  condition: ctx => !ctx.get('ragResults')?.length,
  ifTrue: {
    type: 'web-search',
    query: ctx => ctx.get('topics')?.[0]?.title,
    output: 'searchResults'
  }
}
```

---

## ⚠️ 注意事项

1. **超时设置**：web-search 建议设置 `timeout: 20000`（20 秒）
2. **结果数量**：`count` 范围 1-10，推荐 5
3. **新鲜度**：`freshness` 可选，不填则搜索全部内容
4. **错误处理**：搜索失败会触发流程的 `onError` 处理

---

## 🐛 调试技巧

### 查看搜索日志

```bash
pm2 logs workflow-engine --lines 100 | grep "web-search"
```

### 测试搜索功能

发送消息：`帮我分析一下最近的 AI 发展趋势`

预期流程：
1. ✅ 触发 `analysis_flow`
2. ✅ 提炼主题："AI 发展趋势"
3. ✅ 知识库检索（可能为空）
4. ✅ 自动触发 web-search
5. ✅ 生成热点分析报告

---

## 📝 修改历史

- **2026-04-24**: 初始版本，支持 `web-search` 步骤和 `skill-proxy` 兼容模式
- 支持 Brave、DuckDuckGo 等搜索提供商
- 自动降级逻辑：知识库 → 网络搜索

---

## 🔗 相关文档

- [OpenClaw Brave Search 文档](https://docs.openclaw.ai/tools/brave-search.md)
- [工作流配置指南](./WORKFLOW_CONFIG.md)
- [步骤开发指南](../steps/STEP_GUIDE.md)

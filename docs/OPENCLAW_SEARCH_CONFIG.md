# OpenClaw Web Search 配置示例

## 📋 方案 1：DuckDuckGo（免费，推荐入门）

**优点：** 无需 API Key，开箱即用  
**缺点：** 搜索结果质量一般，可能有限流

```json
{
  "plugins": {
    "allow": [
      "my-qq-filter",
      "memory-core",
      "qqbot"
    ],
    "entries": {
      "duckduckgo": {
        "config": {
          "enabled": true
        }
      }
    }
  },
  "tools": {
    "web": {
      "search": {
        "provider": "duckduckgo",
        "maxResults": 5,
        "timeoutSeconds": 30
      }
    }
  }
}
```

---

## 📋 方案 2：Brave Search（推荐生产使用）

**优点：** 搜索结果质量好，稳定，支持高级参数  
**缺点：** 需要 API Key（免费额度：每月 2000 次）

### 步骤 1：获取 API Key

1. 访问 https://brave.com/search/api/
2. 注册账号
3. 生成 API Key（免费计划）

### 步骤 2：配置

```json
{
  "plugins": {
    "allow": [
      "my-qq-filter",
      "memory-core",
      "qqbot"
    ],
    "entries": {
      "brave": {
        "config": {
          "webSearch": {
            "apiKey": "YOUR_BRAVE_API_KEY_HERE",
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

---

## 📋 方案 3：完整配置（你的当前配置 + 搜索）

```json
{
  "meta": {
    "lastTouchedVersion": "2026.4.14",
    "lastTouchedAt": "2026-04-19T05:16:05.028Z"
  },
  "auth": {
    "profiles": {
      "qwen-portal:default": {
        "provider": "qwen-portal",
        "mode": "oauth"
      }
    }
  },
  "models": {
    "providers": {
      "dashscope": {
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKey": "sk-4685cc96e3c34be58f07368fe6627b4e",
        "api": "openai-completions",
        "models": [
          {
            "id": "qwen-plus",
            "name": "Qwen Plus"
          }
        ]
      }
    }
  },
  "tools": {
    "profile": "coding",
    "web": {
      "search": {
        "provider": "duckduckgo",
        "maxResults": 5,
        "timeoutSeconds": 30
      }
    }
  },
  "channels": {
    "qqbot": {
      "enabled": true,
      "allowFrom": ["*"],
      "appId": "1903535544",
      "clientSecret": "HSQEzc3GIIFVl0CY"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "96b97e20d458455e4ba12dacccaa5655060dd542f68d167c"
    }
  },
  "plugins": {
    "allow": [
      "my-qq-filter",
      "memory-core",
      "qqbot"
    ],
    "entries": {
      "duckduckgo": {
        "config": {
          "enabled": true
        }
      }
    }
  }
}
```

---

## 🚀 快速应用

### 方式 1：手动编辑

```bash
# 备份当前配置
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak

# 编辑配置
code ~/.openclaw/openclaw.json  # 或使用你喜欢的编辑器
```

在 `plugins` 部分添加：
```json
"plugins": {
  "allow": [
    "my-qq-filter",
    "memory-core",
    "qqbot"
  ],
  "entries": {
    "duckduckgo": {
      "config": {
        "enabled": true
      }
    }
  }
}
```

在 `tools` 部分添加：
```json
"tools": {
  "profile": "coding",
  "web": {
    "search": {
      "provider": "duckduckgo",
      "maxResults": 5,
      "timeoutSeconds": 30
    }
  }
}
```

### 方式 2：使用脚本自动配置

```bash
cd /home/adminlinux/.openclaw

# 备份
cp openclaw.json openclaw.json.bak

# 使用 Node.js 脚本添加配置
node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('openclaw.json', 'utf8'));

// 添加 DuckDuckGo 插件
config.plugins.entries = config.plugins.entries || {};
config.plugins.entries.duckduckgo = {
  config: { enabled: true }
};

// 添加 web search 配置
config.tools.web = {
  search: {
    provider: 'duckduckgo',
    maxResults: 5,
    timeoutSeconds: 30
  }
};

fs.writeFileSync('openclaw.json', JSON.stringify(config, null, 2));
console.log('✅ 配置已更新');
"

# 重启 OpenClaw Gateway
openclaw gateway restart
```

---

## ✅ 验证配置

### 1. 检查 Gateway 日志

```bash
openclaw gateway logs --lines 50 | grep -i "search\|duckduckgo\|brave"
```

### 2. 测试搜索功能

发送消息到 QQ：
```
帮我分析一下最近的 AI 发展趋势
```

查看工作流引擎日志：
```bash
pm2 logs workflow-engine --lines 50 | grep "web-search"
```

预期看到：
```
🔍 调用 OpenClaw Skill: web-search
✅ Skill 调用完成：web-search
```

---

## 🔧 故障排查

### 问题 1：搜索不工作

**检查：**
```bash
# 查看配置是否正确
cat ~/.openclaw/openclaw.json | grep -A 10 '"web"'

# 查看 Gateway 是否加载配置
openclaw gateway status
```

### 问题 2：API Key 错误（Brave）

**解决：**
1. 检查 API Key 是否正确
2. 确认免费额度未用完
3. 查看 Brave 控制台：https://api.search.brave.com/app/dashboard

### 问题 3：超时

**解决：**
```json
"tools": {
  "web": {
    "search": {
      "timeoutSeconds": 60  // 增加到 60 秒
    }
  }
}
```

---

## 📊 搜索提供商对比

| 提供商 | 价格 | 质量 | 配置难度 | 推荐场景 |
|--------|------|------|---------|---------|
| **DuckDuckGo** | 免费 | ⭐⭐⭐ | 简单 | 测试/个人使用 |
| **Brave** | 免费 2000 次/月 | ⭐⭐⭐⭐⭐ | 中等 | 生产环境 |
| **Google** | 付费 | ⭐⭐⭐⭐⭐ | 复杂 | 企业级 |
| **Bing** | 付费 | ⭐⭐⭐⭐ | 中等 | 企业级 |

---

## 🎯 推荐配置

**个人使用：** DuckDuckGo（免费，够用）  
**生产环境：** Brave Search（质量好，稳定）

**配置示例（Brave）：**
```json
{
  "plugins": {
    "entries": {
      "brave": {
        "config": {
          "webSearch": {
            "apiKey": "BSK_YOUR_API_KEY_HERE",
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
        "timeoutSeconds": 30,
        "freshness": "week"  // 默认搜索最近一周的内容
      }
    }
  }
}
```

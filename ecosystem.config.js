'use strict'

module.exports = {
  apps: [
    {
      name: 'workflow-engine',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',

      // 自动重启策略
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,

      // 内存超限自动重启（防内存泄漏）
      max_memory_restart: '1G',

      // 环境变量（从 .env 文件加载，此处仅覆盖 NODE_ENV）
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      },

      // 日志路径
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // 优雅退出：等待 SIGINT 处理完成
      kill_timeout: 5000,
      listen_timeout: 10000
    }
  ]
}

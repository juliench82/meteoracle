module.exports = {
  apps: [
    {
      name: 'meteoracle-worker',
      script: 'tsx',
      args: '--tsconfig tsconfig.worker.json worker.ts',
      cwd: './',
      env: {
        NODE_ENV: 'production'
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'meteoracle-telegram',
      script: 'tsx',
      args: 'bot/telegram-bot.ts',
      cwd: './',
      env: {
        NODE_ENV: 'production'
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    }
  ]
}

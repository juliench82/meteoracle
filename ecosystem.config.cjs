module.exports = {
  apps: [
    {
      name: 'meteoracle-worker',
      script: 'node',
      args: 'dist/worker.js',
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
      script: 'node',
      args: 'dist/bot/telegram-bot.js',
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

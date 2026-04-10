/**
 * ecosystem.config.cjs  — PM2 process config
 *
 * Keeps all 3 bot processes alive on the VPS.
 * Restarts automatically on crash or reboot.
 *
 * Setup:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save          # persist across reboots
 *   pm2 startup       # auto-start on system boot (follow the printed command)
 *
 * Commands:
 *   pm2 status        # see all processes
 *   pm2 logs          # tail all logs
 *   pm2 logs scanner  # tail single process
 *   pm2 restart all   # restart everything
 *   pm2 stop all      # pause without deleting
 *
 * Environment:
 *   PM2 reads .env.local automatically via the env block below.
 *   You can also run: pm2 start ecosystem.config.cjs --env production
 */

module.exports = {
  apps: [
    {
      name:         'scanner',
      script:       'npx',
      args:         'tsx bot/pre-grad-scanner.ts',
      interpreter:  'none',
      cwd:          __dirname,
      restart_delay: 5_000,
      max_restarts: 10,
      env: {
        NODE_ENV:     'production',
        BOT_DRY_RUN: 'false',   // ← flip to 'true' to go back to dry-run
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file:  './logs/scanner-error.log',
      out_file:    './logs/scanner-out.log',
      merge_logs:  true,
    },
    {
      name:         'buyer',
      script:       'npx',
      args:         'tsx bot/spot-buyer.ts',
      interpreter:  'none',
      cwd:          __dirname,
      restart_delay: 5_000,
      max_restarts: 10,
      env: {
        NODE_ENV:     'production',
        BOT_DRY_RUN: 'false',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file:  './logs/buyer-error.log',
      out_file:    './logs/buyer-out.log',
      merge_logs:  true,
    },
    {
      name:         'monitor',
      script:       'npx',
      args:         'tsx bot/spot-monitor.ts',
      interpreter:  'none',
      cwd:          __dirname,
      restart_delay: 5_000,
      max_restarts: 10,
      env: {
        NODE_ENV:     'production',
        BOT_DRY_RUN: 'false',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file:  './logs/monitor-error.log',
      out_file:    './logs/monitor-out.log',
      merge_logs:  true,
    },
  ],
}

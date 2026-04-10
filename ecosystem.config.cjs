/**
 * ecosystem.config.cjs  — PM2 process config
 *
 * 5 long-running bot processes:
 *   scanner    — polls pump.fun every 60s for pre-grad tokens
 *   buyer      — buys watchlist tokens via Jupiter every 30s
 *   monitor    — checks TP/SL/timeout on spot positions every 30s
 *   migrator   — detects graduation, opens Meteora DLMM LP every 60s
 *   lp-monitor — monitors LP range health + exits every 5min
 *
 * Setup:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   ← follow the printed command
 *
 * Update after git pull:
 *   git pull && pm2 restart all
 */

module.exports = {
  apps: [
    {
      name:          'scanner',
      script:        'npx',
      args:          'tsx bot/pre-grad-scanner.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  5_000,
      max_restarts:   10,
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'false' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/scanner-error.log',
      out_file:   './logs/scanner-out.log',
      merge_logs: true,
    },
    {
      name:          'buyer',
      script:        'npx',
      args:          'tsx bot/spot-buyer.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  5_000,
      max_restarts:   10,
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'false' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/buyer-error.log',
      out_file:   './logs/buyer-out.log',
      merge_logs: true,
    },
    {
      name:          'monitor',
      script:        'npx',
      args:          'tsx bot/spot-monitor.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  5_000,
      max_restarts:   10,
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'false' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/monitor-error.log',
      out_file:   './logs/monitor-out.log',
      merge_logs: true,
    },
    {
      name:          'migrator',
      script:        'npx',
      args:          'tsx bot/lp-migrator.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  10_000,
      max_restarts:   10,
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'false' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/migrator-error.log',
      out_file:   './logs/migrator-out.log',
      merge_logs: true,
    },
    {
      name:          'lp-monitor',
      script:        'npx',
      args:          'tsx bot/lp-monitor.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  10_000,
      max_restarts:   10,
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'false' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/lp-monitor-error.log',
      out_file:   './logs/lp-monitor-out.log',
      merge_logs: true,
    },
  ],
}

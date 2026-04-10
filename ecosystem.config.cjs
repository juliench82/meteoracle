/**
 * ecosystem.config.cjs  — PM2 process config
 *
 * 7 long-running bot processes (2 parallel pipelines):
 *
 * PIPELINE 1: Meteora DLMM LP (any pool on Solana)
 *   lp-scanner     — polls all Meteora pools every 15min → Evil Panda / Scalp Spike / Stable Farm
 *   lp-monitor-dlmm— monitors LP range health + exits every 5min
 *
 * PIPELINE 2: Pre-grad spot buy (pump.fun)
 *   scanner        — polls pump.fun every 60s for 80–99% bonding curve tokens
 *   buyer          — buys watchlist tokens via Jupiter every 30s
 *   monitor        — checks TP/SL/timeout on spot positions every 30s
 *
 * PIPELINE 3: Post-grad LP bridge
 *   migrator       — detects graduation, opens Meteora DLMM LP every 60s
 *   lp-monitor     — monitors post-grad LP positions every 5min
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
    // ── PIPELINE 1: Meteora DLMM LP (independent, always running) ──
    {
      name:          'lp-scanner',
      script:        'npx',
      args:          'tsx bot/scanner.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  10_000,
      max_restarts:   10,
      env: {
        NODE_ENV:              'production',
        BOT_DRY_RUN:           'false',
        LP_SCANNER_STANDALONE: 'true',
        LP_SCAN_INTERVAL_SEC:  '900',   // 15min
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/lp-scanner-error.log',
      out_file:   './logs/lp-scanner-out.log',
      merge_logs: true,
    },
    {
      name:          'lp-monitor-dlmm',
      script:        'npx',
      args:          'tsx bot/monitor.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  10_000,
      max_restarts:   10,
      env: {
        NODE_ENV:               'production',
        BOT_DRY_RUN:            'false',
        LP_MONITOR_STANDALONE:  'true',
        LP_MONITOR_INTERVAL_SEC: '300',  // 5min
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/lp-monitor-dlmm-error.log',
      out_file:   './logs/lp-monitor-dlmm-out.log',
      merge_logs: true,
    },

    // ── PIPELINE 2: Pre-grad spot buy ──
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

    // ── PIPELINE 3: Post-grad LP bridge ──
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

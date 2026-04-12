/**
 * ecosystem.config.cjs  — PM2 process config
 *
 * Processes:
 *
 * PIPELINE 1: Meteora DLMM LP
 *   lp-scanner       — polls Meteora pools every 15min
 *   lp-monitor-dlmm  — monitors LP range health + exits every 5min
 *
 * PIPELINE 2: Pre-grad spot buy (pump.fun)
 *   scanner          — polls pump.fun every 60s for 80–99% bonding curve tokens
 *   buyer            — buys watchlist tokens via Jupiter every 30s
 *   monitor          — checks TP/SL/timeout on spot positions every 30s
 *
 * PIPELINE 3: Post-grad LP bridge
 *   migrator         — detects graduation, opens Meteora DLMM LP every 60s
 *   lp-monitor       — monitors post-grad LP positions every 5min
 *
 * INTERFACE
 *   telegram-bot     — Telegram command interface (/tick, /positions, etc.)
 *   dashboard        — Next.js dashboard on port 3000
 *                      Uses start-dashboard.sh which cleans .next before every start.
 *
 * Setup:
 *   npm install -g pm2
 *   chmod +x start-dashboard.sh
 *   set -a && source .env.local && set +a
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   ← follow the printed command
 *
 * Deploy:
 *   git pull && pm2 restart all --update-env && pm2 save
 *   (start-dashboard.sh handles rm -rf .next && npm run build automatically)
 *
 * DRY-RUN vs LIVE:
 *   BOT_DRY_RUN=true  — simulate only, no real txs, no wallet needed
 *   BOT_DRY_RUN=false — live mode, REAL money, fund wallet first
 */

module.exports = {
  apps: [
    // ── PIPELINE 1: Meteora DLMM LP ──
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
        BOT_DRY_RUN:           'true',
        LP_SCANNER_STANDALONE: 'true',
        LP_SCAN_INTERVAL_SEC:  '900',
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
        BOT_DRY_RUN:            'true',
        LP_MONITOR_STANDALONE:  'true',
        LP_MONITOR_INTERVAL_SEC: '300',
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
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'true' },
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
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'true' },
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
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'true' },
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
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'true' },
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
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'true' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/lp-monitor-error.log',
      out_file:   './logs/lp-monitor-out.log',
      merge_logs: true,
    },

    // ── INTERFACE ──
    {
      name:          'telegram-bot',
      script:        'npx',
      args:          'tsx bot/telegram-bot.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  5_000,
      max_restarts:   10,
      env: { NODE_ENV: 'production', BOT_DRY_RUN: 'true' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/telegram-bot-error.log',
      out_file:   './logs/telegram-bot-out.log',
      merge_logs: true,
    },
    {
      name:          'dashboard',
      script:        './start-dashboard.sh',
      interpreter:   'bash',
      cwd:           __dirname,
      restart_delay:  10_000,
      max_restarts:   5,
      env_file:      '.env.local',
      env: {
        NODE_ENV: 'production',
        PORT:     '3000',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/dashboard-error.log',
      out_file:   './logs/dashboard-out.log',
      merge_logs: true,
    },
  ],
}

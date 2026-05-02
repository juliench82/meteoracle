/**
 * ecosystem.config.cjs  — PM2 process config
 *
 * Processes:
 *
 * PIPELINE 1: Meteora DLMM LP (the only pipeline)
 *   lp-scanner       — polls Meteora pools every 15min, classifies token, opens LP
 *   lp-monitor-dlmm  — monitors LP range health, rebalances, exits every 60s
 *
 * INTERFACE
 *   telegram-bot     — Telegram command interface (/tick, /positions, etc.)
 *   dashboard        — Next.js dashboard on port 3000
 *                      Uses start-dashboard.sh which cleans .next before every start.
 *
 * Setup:
 *   npm install -g pm2
 *   chmod +x start-dashboard.sh
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   ← follow the printed command
 *
 * Deploy:
 *   git pull && pm2 restart all --update-env && pm2 save
 *
 * DRY-RUN vs LIVE:
 *   BOT_DRY_RUN=true  — simulate only, no real txs, no wallet needed
 *   BOT_DRY_RUN=false — live mode, REAL money, fund wallet first
 *
 * NODE_OPTIONS note:
 *   --conditions=require forces Node.js to resolve the `require` export condition
 *   on all packages. This makes tsx load @meteora-ag/dlmm's compiled CJS dist
 *   (./dist/index.cjs) instead of its TypeScript source (./src/), which would
 *   otherwise trigger an ESM import of { BN } from @coral-xyz/anchor that fails
 *   because the anchor ESM bundle does not re-export BN.
 */

module.exports = {
  apps: [
    // ── PIPELINE 1: Meteora DLMM LP ──────────────────────────────────────────
    {
      name:          'lp-scanner',
      script:        'npx',
      args:          'tsx bot/scanner.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  10_000,
      max_restarts:   10,
      env_file:      '.env.local',
      env: {
        NODE_ENV:              'production',
        LP_SCANNER_STANDALONE: 'true',
        NODE_OPTIONS:          '--conditions=require',
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
      env_file:      '.env.local',
      env: {
        NODE_ENV:              'production',
        LP_MONITOR_STANDALONE: 'true',
        LP_MONITOR_INTERVAL_SEC: '60',
        NODE_OPTIONS:          '--conditions=require',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/lp-monitor-dlmm-error.log',
      out_file:   './logs/lp-monitor-dlmm-out.log',
      merge_logs: true,
    },

    // ── INTERFACE ─────────────────────────────────────────────────────────────
    {
      name:          'telegram-bot',
      script:        'npx',
      args:          'tsx bot/telegram-bot.ts',
      interpreter:   'none',
      cwd:           __dirname,
      restart_delay:  5_000,
      max_restarts:   10,
      env_file:      '.env.local',
      env: {
        NODE_ENV:     'production',
        NODE_OPTIONS: '--conditions=require',
      },
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

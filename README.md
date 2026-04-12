# ⚡ Meteoracle

> Automated Solana trading bot with a live Next.js dashboard. Three active pipelines: pre-graduation pump.fun spot buys, Meteora DLMM LP positions, and a post-grad LP bridge.

**Status:** Live — 9 processes on Hetzner VPS via PM2 (7 bot workers + Telegram command bot + Next.js dashboard).

---

## Architecture

```
Hetzner VPS (PM2 — 9 processes)
  │
  ├── PIPELINE 1: Meteora DLMM LP
  │   ├── bot/scanner.ts          ← scans Meteora pools every 15min   [PM2: lp-scanner]
  │   └── bot/monitor.ts          ← monitors LP range health + exits every 5min  [PM2: lp-monitor-dlmm]
  │
  ├── PIPELINE 2: Pre-grad spot buy (pump.fun)
  │   ├── bot/pre-grad-scanner.ts ← polls pump.fun REST every 60s (88–98% bonding curve)  [PM2: scanner]
  │   ├── bot/spot-buyer.ts       ← buys watchlist tokens via Jupiter every 30s  [PM2: buyer]
  │   └── bot/spot-monitor.ts     ← TP/SL/timeout exits every 30s  [PM2: monitor]
  │
  ├── PIPELINE 3: Post-grad LP bridge
  │   ├── bot/lp-migrator.ts      ← detects graduation, opens Meteora DLMM LP every 60s  [PM2: migrator]
  │   └── bot/lp-monitor.ts       ← monitors post-grad LP positions every 5min  [PM2: lp-monitor]
  │
  └── INTERFACE
      ├── bot/telegram-bot.ts     ← bidirectional Telegram command bot  [PM2: telegram-bot]
      └── start-dashboard.sh      ← cleans .next + builds + starts Next.js on port 3000  [PM2: dashboard]

Next.js dashboard (same VPS, port 3000, served by PM2)
  └── app/(dashboard)/
      ├── page.tsx                ← KPIs, P&L chart, combined positions table (SPOT + LP), watchlist
      └── strategies/page.tsx     ← Strategy config + live performance
      (bot/ and settings/ pages removed)

Supabase (Postgres)
  ├── pre_grad_watchlist          ← tokens detected by pre-grad scanner
  ├── spot_positions              ← all pre-grad trades (open + closed)
  ├── lp_positions                ← all LP positions (open + closed) — Pipelines 1 & 3
  ├── candidates                  ← Meteora scanner candidates log
  ├── bot_logs                    ← structured event log
  └── bot_state                   ← single-row enabled flag; read by all workers + dashboard

Telegram — bidirectional (alerts out + commands in)
```

---

## Pipeline 1 — Meteora DLMM LP

Scans all Meteora pools every 15 minutes. Filters by market cap, volume, liquidity, age, holder count, rugcheck score. Opens a DLMM LP position with a tight bin range centered at current price. Monitors range health every 5 minutes — smart-rebalances if price drifts >30% inside range, closes on stop-loss / take-profit / max duration / out-of-range timeout.

## Pipeline 2 — Pre-grad Spot Buy

Scans pump.fun tokens at 88–98% bonding curve progress every 60 seconds via the pump.fun REST API (no Bitquery, no API key required). Enriches each candidate with pump.fun API data: bonding curve %, holder count, top holder %, dev wallet %. Buys via Jupiter v6. Exits at +150% TP, -35% SL, or 90-minute timeout.

### Current filters

| Filter | Default | Env var |
|---|---|---|
| Bonding curve | 88–98% | `PRE_GRAD_MIN_BONDING_PCT` / `PRE_GRAD_MAX_BONDING_PCT` |
| Volume (5 min) | ≥ 8 SOL | `PRE_GRAD_MIN_VOL_5MIN_SOL` |
| Holders | ≥ 100 | `PRE_GRAD_MIN_HOLDERS` |
| Top holder | ≤ 12% | `PRE_GRAD_MAX_TOP_HOLDER` |
| Dev wallet | ≤ 3% | `PRE_GRAD_MAX_DEV_WALLET_PCT` |
| Take profit | +150% | `PRE_GRAD_TP_PCT` |
| Stop loss | -35% | `PRE_GRAD_SL_PCT` |
| Max hold | 90 min | `PRE_GRAD_MAX_HOLD_MIN` |

## Pipeline 3 — Post-grad LP Bridge

Detects pump.fun graduation events every 60 seconds, then opens a Meteora DLMM LP position for the newly listed token. Monitors LP health and exits on the same conditions as Pipeline 1.

---

## Telegram bot commands

The `telegram-bot` process is a **bidirectional** command interface, not just outbound alerts.

| Command | Action |
|---|---|
| `/stop` | Emergency stop — closes all open positions + `pm2 stop` all workers |
| `/restart` | Restarts all workers (not telegram-bot itself) + sets botState enabled |
| `/close` | Manually close all open positions |
| `/tick` | Runs one tick of all 5 pipeline runners in parallel (55s timeout each) |
| `/positions` | Shows all open spot + LP positions |
| `/status` | Shows bot state (enabled/disabled), open position count, wallet balance |
| `/help` | Lists all commands |

### Outbound alerts

| Alert | Trigger |
|---|---|
| 🟢 BUY token | Spot position opened |
| 🟡 [DRY-RUN] BUY | Dry-run position opened |
| 🟢 CLOSED TP ✅ | Take profit hit |
| 🔴 CLOSED SL ❌ | Stop loss hit |
| ⏱️ CLOSED TIMEOUT | Max hold exceeded |
| 🔁 REBALANCED | Smart rebalance triggered |
| ⚠️ LOW BALANCE | Wallet below minimum |
| ❌ BUY FAILED | Jupiter swap error |
| 🚀 STARTUP (crash restart) | Process restarted after crash (PM2_RESTART_COUNT > 0) |

---

## Repo structure

```
meteoracle/
├── app/
│   └── (dashboard)/            ← All Next.js pages (shared layout)
│       ├── page.tsx            ← Main dashboard (KPIs, P&L, positions, watchlist)
│       └── strategies/page.tsx ← Strategy config + performance
├── bot/
│   ├── pre-grad-scanner.ts     ← Pipeline 2 scanner
│   ├── spot-buyer.ts           ← Pipeline 2 buyer
│   ├── spot-monitor.ts         ← Pipeline 2 monitor
│   ├── spot-seller.ts          ← Jupiter sell helper
│   ├── scanner.ts              ← Pipeline 1 Meteora scanner
│   ├── monitor.ts              ← Pipeline 1 LP monitor (DLMM)
│   ├── lp-migrator.ts          ← Pipeline 3 post-grad bridge
│   ├── lp-monitor.ts           ← Pipeline 3 LP monitor
│   ├── executor.ts             ← LP open/close execution
│   ├── alerter.ts              ← Telegram alert dispatcher
│   ├── scorer.ts               ← Meteora candidate scorer
│   ├── startup-alert.ts        ← Fires Telegram ping on PM2 crash restart
│   ├── telegram-bot.ts         ← Bidirectional Telegram command bot
│   └── orphan-detector.ts      ← Detects DB positions no longer on-chain
├── strategies/
│   └── pre-grad.ts             ← Pipeline 2 config (all tunable via env)
├── lib/
│   ├── supabase.ts
│   ├── solana.ts
│   ├── helius.ts
│   ├── rugcheck.ts
│   └── types.ts
├── supabase/migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_entry_price_usd.sql
│   ├── 003_meteora_lp_schema.sql
│   └── 004_pre_grad_watchlist_velocity.sql
├── ecosystem.config.cjs        ← PM2 config (all 9 processes)
├── start-dashboard.sh          ← Cleans .next, builds, starts Next.js (called by PM2)
└── .env.local.example          ← All env vars with descriptions
```

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
```

### 2. Supabase migrations

Run all 4 migrations in order in the Supabase SQL editor:

```
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_entry_price_usd.sql
supabase/migrations/003_meteora_lp_schema.sql
supabase/migrations/004_pre_grad_watchlist_velocity.sql
```

Also create the `bot_state` row manually once:

```sql
insert into bot_state (id, enabled) values (1, true)
on conflict (id) do nothing;
```

### 3. Environment variables

```bash
cp .env.local.example .env.local
# fill in your values
```

See `.env.local.example` for all variables with descriptions. Required ones are marked.

### 4. Run locally (dry-run)

```bash
# Dashboard
npm run dev

# Bots (separate terminals)
npx tsx bot/pre-grad-scanner.ts
npx tsx bot/spot-buyer.ts
npx tsx bot/spot-monitor.ts
```

### 5. Run everything on VPS (PM2)

All 9 processes — bots, Telegram bot, and dashboard — are managed by PM2 on a single VPS.

```bash
# On your VPS
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
cp .env.local.example .env.local   # fill in your values
chmod +x start-dashboard.sh
npm install -g pm2

# Load env into shell before starting PM2
set -a && source .env.local && set +a

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command — survives reboots
```

Check status:

```bash
pm2 status
# Pipeline 1
pm2 logs lp-scanner --lines 50
pm2 logs lp-monitor-dlmm --lines 50
# Pipeline 2
pm2 logs scanner --lines 50
pm2 logs buyer --lines 50
pm2 logs monitor --lines 50
# Pipeline 3
pm2 logs migrator --lines 50
pm2 logs lp-monitor --lines 50
# Interface
pm2 logs telegram-bot --lines 50
pm2 logs dashboard --lines 50
```

Update after a code push:

```bash
git pull && pm2 restart all --update-env && pm2 save
```

> `start-dashboard.sh` automatically runs `rm -rf .next && npm run build` before each dashboard start, so stale build cache is never an issue.

---

## Go-live checklist

- [ ] All 4 Supabase migrations applied
- [ ] `bot_state` row inserted (`id=1, enabled=true`)
- [ ] Wallet funded (≥ 0.5 SOL — covers positions + gas)
- [ ] `BOT_DRY_RUN=false` set in `.env.local` on VPS
- [ ] `chmod +x start-dashboard.sh`
- [ ] `set -a && source .env.local && set +a` run before `pm2 start`
- [ ] PM2 started and saved: `pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`
- [ ] Telegram alert fires on first live buy
- [ ] Dashboard accessible at `http://<vps-ip>:3000`

---

## Required accounts

- [Helius](https://helius.dev) — Solana RPC (free tier fine)
- [Supabase](https://supabase.com) — Postgres DB (free tier fine)
- [Rugcheck](https://rugcheck.xyz) — token safety scores (no key needed)
- Telegram bot via @BotFather
- Hetzner VPS (CX22 recommended — ~€4/mo)

> **No Bitquery API key required.** The pre-grad scanner uses the pump.fun REST API directly.

---

## Disclaimer

Experimental software. Meme token and LP trading is extremely high risk. Never deploy funds you cannot afford to lose entirely. Always validate in dry-run mode first.

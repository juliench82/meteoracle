# ⚡ Meteoracle

> Automated Solana LP fee-farming bot with a live Next.js dashboard. One active pipeline: Meteora DLMM LP positions driven by a multi-strategy token classifier.

**Status:** Live — 3 processes on Hetzner VPS via PM2 (scanner + monitor + dashboard).

---

## Architecture

```
Hetzner VPS (PM2)
  │
  ├── bot/scanner.ts          ← scans Meteora pools every 15min   [PM2: lp-scanner]
  ├── bot/monitor.ts          ← monitors LP range health + exits every 5min  [PM2: lp-monitor-dlmm]
  │
  └── INTERFACE
      ├── bot/telegram-bot.ts ← bidirectional Telegram command bot  [PM2: telegram-bot]
      └── start-dashboard.sh  ← cleans .next + builds + starts Next.js on port 3000  [PM2: dashboard]

Next.js dashboard (same VPS, port 3000)
  └── app/(dashboard)/
      ├── page.tsx                ← KPIs, P&L chart, positions table, watchlist
      └── strategies/page.tsx     ← Strategy config + live performance

Supabase (Postgres)
  ├── lp_positions                ← all LP positions (open + closed)
  ├── candidates                  ← scanner candidates log (includes token_class + strategy_id)
  ├── bot_logs                    ← structured event log
  └── bot_state                   ← single-row enabled flag

Telegram — bidirectional (alerts out + commands in)
```

---

## Token Classifier

`strategies/index.ts` exports `classifyToken()` which assigns each scanned token one of five classes before strategy routing:

| Class | Criteria | Strategy |
|---|---|---|
| `MEME_SHITCOIN` | age < 48h OR mc < $3M OR vol1h/liq > 5% OR top10holders > 35% | Evil Panda |
| `SCALP_SPIKE` | 48h–30d, $3M–$20M mc, vol1h/liq ≤ 5% | Scalp-Spike |
| `BLUECHIP` | age > 30d, mc > $20M, top10holders < 25% | Stable Farm |
| `STABLE` | known stablecoin mint (USDC/USDT/USDH/PAI/stSOL) | Stable Farm |
| `UNKNOWN` | no clean fit → no position opened | — |

`token_class` and `strategy_id` are persisted on every `candidates` and `lp_positions` row (migration `20260417_add_token_class.sql`), enabling per-class P&L breakdown in the dashboard.

---

## Strategies

| File | ID | Status | Class target |
|---|---|---|---|
| `strategies/evil-panda.ts` | `evil-panda` | ✅ Active | MEME_SHITCOIN |
| `strategies/scalp-spike.ts` | `scalp-spike` | ✅ Active | SCALP_SPIKE |
| `strategies/stable-farm.ts` | `stable-farm` | ✅ Active | BLUECHIP / STABLE |

---

## Telegram bot commands

| Command | Action |
|---|---|
| `/stop` | Emergency stop — closes all open positions + sets botState disabled |
| `/restart` | Restarts all workers + sets botState enabled |
| `/close` | Manually close all open positions |
| `/tick` | Runs one scanner + monitor tick immediately |
| `/positions` | Shows all open LP positions |
| `/status` | Shows bot state, open position count, wallet balance |
| `/help` | Lists all commands |

### Outbound alerts

| Alert | Trigger |
|---|---|
| 🟢 LP OPENED | Position opened |
| 🔴 CLOSED SL | Stop loss hit |
| ✅ CLOSED TP | Take profit hit |
| ⏱️ CLOSED TIMEOUT | Max duration exceeded |
| 🔁 REBALANCED | Smart rebalance triggered |
| ⚠️ LOW BALANCE | Wallet below minimum |
| 🚀 STARTUP | Process restarted after crash |

---

## Repo structure

```
meteoracle/
├── app/
│   └── (dashboard)/
│       ├── page.tsx                ← KPIs, P&L, positions table
│       └── strategies/page.tsx     ← Strategy config + performance
├── bot/
│   ├── scanner.ts                  ← Meteora pool scanner
│   ├── monitor.ts                  ← LP range monitor + exit logic
│   ├── executor.ts                 ← LP open/close execution
│   ├── alerter.ts                  ← Telegram alert dispatcher
│   ├── scorer.ts                   ← Candidate scorer
│   ├── startup-alert.ts            ← PM2 crash-restart ping
│   ├── telegram-bot.ts             ← Bidirectional Telegram bot
│   └── orphan-detector.ts          ← Detects DB positions no longer on-chain
├── strategies/
│   ├── index.ts                    ← STRATEGIES registry + classifyToken() + getStrategyForToken()
│   ├── evil-panda.ts               ← MEME_SHITCOIN strategy
│   ├── scalp-spike.ts              ← SCALP_SPIKE strategy
│   └── stable-farm.ts              ← BLUECHIP/STABLE strategy
├── lib/
│   ├── supabase.ts
│   ├── solana.ts
│   ├── helius.ts
│   ├── rugcheck.ts
│   ├── pumpfun.ts
│   └── types.ts
├── supabase/migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_add_updated_at.sql
│   ├── 002_entry_price_usd.sql
│   ├── 003_bot_state.sql
│   ├── 003_lp_positions.sql
│   ├── 004_pre_grad_watchlist.sql
│   ├── 004_pre_grad_watchlist_velocity.sql
│   └── 20260417_add_token_class.sql
├── ecosystem.config.cjs
├── start-dashboard.sh
└── .env.local.example
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

Run all 8 migrations in order in the Supabase SQL editor:

```
001_initial_schema.sql
002_add_updated_at.sql
002_entry_price_usd.sql
003_bot_state.sql
003_lp_positions.sql
004_pre_grad_watchlist.sql
004_pre_grad_watchlist_velocity.sql
20260417_add_token_class.sql
```

Then seed the `bot_state` row:

```sql
insert into bot_state (id, enabled) values (1, true)
on conflict (id) do nothing;
```

### 3. Environment variables

```bash
cp .env.local.example .env.local
# fill in your values
```

### 4. Run on VPS (PM2)

```bash
npm install -g pm2
set -a && source .env.local && set +a
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command
```

Check logs:

```bash
pm2 logs lp-scanner --lines 50
pm2 logs lp-monitor-dlmm --lines 50
pm2 logs telegram-bot --lines 50
pm2 logs dashboard --lines 50
```

Deploy update:

```bash
git pull && pm2 restart all --update-env && pm2 save
```

---

## Go-live checklist

- [ ] All 8 Supabase migrations applied
- [ ] `bot_state` row inserted (`id=1, enabled=true`)
- [ ] Wallet funded (≥ 0.5 SOL)
- [ ] `BOT_DRY_RUN=false` in `.env.local`
- [ ] `chmod +x start-dashboard.sh`
- [ ] `set -a && source .env.local && set +a` run before `pm2 start`
- [ ] `pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`
- [ ] Dashboard accessible at `http://<vps-ip>:3000`

---

## Required accounts

- [Helius](https://helius.dev) — Solana RPC + holder data (free tier fine)
- [Supabase](https://supabase.com) — Postgres DB (free tier fine)
- [Rugcheck](https://rugcheck.xyz) — token safety scores (no key needed)
- Telegram bot via @BotFather
- Hetzner VPS (CX22 ~€4/mo)

---

## Disclaimer

Experimental software. LP and meme token trading is extremely high risk. Never deploy funds you cannot afford to lose entirely. Validate in dry-run mode first.

# Meteoracle

Automated on-chain liquidity provision bot for Solana. Scans Meteora DLMM and DAMM v2 pools in real time, classifies tokens by risk profile, deploys capital into concentrated liquidity positions, and manages exits — all without human intervention.

Built and operated as a solo project. Production-grade, self-hosted.

**Stack:** TypeScript · Next.js 14 · Supabase (Postgres) · Solana web3.js · Meteora DLMM SDK · Meteora DAMM v2 SDK · Zap SDK · PM2

---

## What it does

1. **Scans** — Continuously polls Meteora DLMM and DAMM v2 pools, filtering candidates by liquidity, volume, age, holder distribution, and safety score.
2. **Classifies** — Each token is assigned a risk class by a multi-signal classifier combining on-chain data, holder analysis, and market structure.
3. **Deploys** — Based on the risk class, the bot selects the appropriate strategy and opens a concentrated liquidity position.
4. **Monitors** — A per-tick monitor tracks each open position: price movement, fee accrual, range status, and elapsed time. USD values are fetched from the Meteora REST API each tick — no local price computation.
5. **Exits** — Positions are closed automatically on configurable conditions. DLMM positions exit via standard remove-liquidity. DAMM v2 positions exit via Zap Out → 100% SOL.
6. **Alerts** — All events (opens, closes, errors, balance warnings) are dispatched via Telegram in real time with rich USD-denominated P&L data.

---

## Architecture

```
VPS (PM2)
  │
  ├── bot/scanner.ts          ← pool scanner + classifier + position opener (DLMM)
  ├── bot/monitor.ts          ← DLMM position monitor + exit engine
  ├── bot/damm-executor.ts    ← DAMM v2 open + close (Zap Out) + PnL fetch
  ├── bot/alerter.ts          ← Telegram alert dispatcher
  ├── bot/telegram-bot.ts     ← bidirectional Telegram command interface
  └── start-dashboard.sh      ← Next.js dashboard (port 3000)

lib/
  ├── pre-grad.ts             ← DAMM v2 monitor loop + exit handler
  └── types.ts                ← shared types

Next.js Dashboard
  └── app/(dashboard)/
      ├── page.tsx            ← live KPIs, P&L chart, open positions table
      └── strategies/page.tsx ← strategy reference + per-strategy performance

Supabase (Postgres)
  ├── lp_positions            ← all positions, open and closed
  ├── candidates              ← every scanned token with full classifier output
  ├── bot_logs                ← structured event log
  └── bot_state               ← killswitch + runtime flags (dry_run)
```

---

## Two execution tracks

The bot runs two parallel execution tracks, each targeting a different pool type:

| Track | Pool type | SDK | Exit method |
|---|---|---|---|
| DLMM | Meteora DLMM (bin-based) | `@meteora-ag/dlmm` | Remove liquidity |
| DAMM v2 / pre-grad | Meteora DAMM v2 (CPMM) | `@meteora-ag/cp-amm-sdk` + `@meteora-ag/zap-sdk` | Zap Out → SOL |

### DAMM v2 track

Positions are opened single-sided in SOL using `createPositionAndAddLiquidity`. `liquidityDelta` is computed from `sdk.getDepositQuote()` for the correct side (token A or B depending on which is WSOL).

At close, `zapOutThroughDammV2` converts 100% of the position back to SOL in a single transaction. After confirmation, the Meteora DAMM v2 REST API is queried (up to 4 retries, 1.5s gap) for authoritative post-close `realized_pnl_usd` and `total_fee_earned_usd`. These are written to the DB row and surfaced in the Telegram close alert.

All USD money fields (claimable fees, position value, realized PnL) come from the Meteora REST API — no local price computation.

---

## Strategies

Strategy selection is fully automatic — the classifier routes each token to the correct strategy based on real-time on-chain data. Strategy parameters (entry filters, position sizing, range config, exit rules) are not published.

| Track | Target |
|---|---|
| DLMM strategies | Various risk profiles — early-stage to established pairs |
| DAMM v2 / pre-grad | Pre-graduation tokens on the DAMM v2 bonding curve |

---

## Telegram alerts

All bot events emit structured Telegram alerts. Close alerts include rich USD data:

```
🌿 Pre-Grad Position Closed
Token: `SYMBOL`
Reason: take-profit
Age: 43min
Value: $12.34
Realized PnL: +$1.82
Claimable Fees: $0.47
```

The bot also accepts inbound commands:

| Command | Action |
|---|---|
| `/status` | Bot state, wallet balance, open position count |
| `/positions` | Live summary of all open positions |
| `/tick` | Trigger one immediate scan + monitor cycle |
| `/close` | Close all open positions |
| `/stop` | Emergency stop — close all positions + disable bot |
| `/restart` | Re-enable bot + restart all workers |
| `/help` | Command reference |

---

## Repo structure

```
meteoracle/
├── app/(dashboard)/           ← Next.js dashboard
├── bot/
│   ├── scanner.ts             ← pool scanner + classifier + opener (DLMM)
│   ├── monitor.ts             ← DLMM position monitor + exit engine
│   ├── executor.ts            ← DLMM on-chain transaction execution
│   ├── damm-executor.ts       ← DAMM v2 open + close (Zap Out) + PnL API
│   ├── alerter.ts             ← Telegram alert dispatcher
│   ├── scorer.ts              ← candidate scoring
│   ├── telegram-bot.ts        ← inbound command handler
│   ├── startup-alert.ts       ← crash-restart notification
│   └── orphan-detector.ts     ← reconciles DB vs on-chain state
├── strategies/
│   └── index.ts               ← classifier + strategy registry
├── lib/
│   ├── pre-grad.ts            ← DAMM v2 monitor loop + exit handler
│   ├── supabase.ts
│   ├── solana.ts
│   ├── helius.ts
│   ├── rugcheck.ts
│   ├── pumpfun.ts
│   └── types.ts
├── supabase/migrations/       ← versioned schema migrations
├── ecosystem.config.cjs       ← PM2 process definitions
└── .env.local.example         ← all required env vars (no secrets)
```

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
```

### 2. Supabase

Create a project at [supabase.com](https://supabase.com), then run the migrations in `supabase/migrations/` in order via the SQL editor. Seed the killswitch row:

```sql
insert into bot_state (id, enabled) values (1, true)
on conflict (id) do nothing;
```

### 3. Environment

Copy the example file and fill in all values:

```bash
cp .env.local.example .env.local
```

Required variables are documented in `.env.local.example`. No secrets are committed to this repo.

### 4. Deploy (PM2)

```bash
npm install -g pm2
set -a && source .env.local && set +a
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

### 5. Check logs

```bash
pm2 logs lp-scanner --lines 50
pm2 logs lp-monitor-dlmm --lines 50
pm2 logs telegram-bot --lines 50
pm2 logs dashboard --lines 50
```

### 6. Deploy update

```bash
git pull && npm install && pm2 restart all --update-env && pm2 save
```

---

## Go-live checklist

- [ ] All Supabase migrations applied
- [ ] `bot_state` row inserted
- [ ] Wallet funded (≥ 0.5 SOL recommended for initial positions)
- [ ] `BOT_TICK_SECRET` set and used for `/api/bot/tick` cron/manual calls
- [ ] `TELEGRAM_WEBHOOK_SECRET` set if using the webhook route
- [ ] `BOT_DRY_RUN=false` confirmed in env
- [ ] `chmod +x start-dashboard.sh`
- [ ] PM2 started and saved
- [ ] Telegram bot responding to `/status`

---

## External services required

| Service | Purpose | Free tier sufficient |
|---|---|---|
| [Helius](https://helius.dev) | Solana RPC + holder data | Yes |
| [Supabase](https://supabase.com) | Postgres database | Yes |
| [Rugcheck](https://rugcheck.xyz) | Token safety scores | Yes (no key needed) |
| Telegram | Alerts + commands | Yes |
| VPS (any provider) | Process hosting | Small instance sufficient |

---

## Disclaimer

Experimental software. Liquidity provision on volatile assets carries significant risk including total loss of deployed capital. This project is published for educational and portfolio purposes. Always run with `BOT_DRY_RUN=true` before deploying real funds.

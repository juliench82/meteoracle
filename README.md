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

The system is split into several focused modules for maintainability:

```
VPS (PM2)
  │
  ├── bot/scanner.ts              ← high-frequency pool scanning + lane classification
  ├── bot/scanner/deep-checker.ts ← deep analysis, scoring, strategy selection
  ├── bot/monitor.ts              ← orchestrator for DLMM + DAMM monitoring ticks
  ├── bot/monitor-*.ts            ← specialized monitors (dlmm, damm, core helpers)
  ├── bot/executor/               ← modular DLMM execution (open / close / add-liquidity / utils)
  ├── bot/damm-executor.ts        ← DAMM v2 open + Zap Out close + PnL
  ├── bot/alerter.ts              ← Telegram alerts
  ├── bot/telegram-bot.ts         ← inbound command handler
  └── start-dashboard.sh          ← Next.js dashboard (port 3000)

lib/
  ├── strategy-config.ts          ← single source of truth for all strategy & scanner tuning
  ├── get-dashboard-data.ts       ← live-first Meteora snapshot + 45s cache (dashboard)
  ├── meteora-live.ts             ← merges live Meteora positions with DB
  ├── solana-tx.ts                ← shared transaction simulation + sending
  └── ...

strategies/
  ├── evil-panda.ts
  ├── scalp-spike.ts
  ├── damm-edge.ts                ← very fresh DAMM v2 edge detector (loosened May 2026)
  └── ...

Next.js Dashboard (live-first)
  └── app/(dashboard)/
      ├── page.tsx                ← open positions + PnL from live Meteora snapshot
      └── strategies/page.tsx     ← strategy reference

Supabase
  ├── lp_positions, candidates, bot_logs, bot_state
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

All strategy parameters are centralized in `lib/strategy-config.ts` and fully tunable via environment variables (see `.env.local.example`).

**Current strategies (May 2026 Option A tuning):**

| Strategy       | Target                                      | Key Defaults                          | Notes |
|----------------|---------------------------------------------|---------------------------------------|-------|
| **Evil Panda** | Fresh SOL-paired memes                      | 3h max age, 250 rugcheck, wide range  | Main workhorse (loosened in Option A) |
| **Scalp Spike**| High-conviction 5m volume surges (≥500k MC) | 6h max duration, tight range          | High conviction, lower frequency |
| **DAMM Edge**  | Extremely fresh DAMM v2 pools               | 25min age, 5% fee/TVL (loosened)      | Isolated high-risk edge track |
| **Stable Farm**| Stablecoin pairs                            | Very tight range, long hold           | Low risk |
| **Bluechip**   | Large-cap USDC/USDT quoted pairs            | Conservative                            | Disabled by default |
| **Moonboy**    | Ultra-early aggressive entries              | 1.5h max age                            | Separate high-risk bucket |

The classifier (`strategies/index.ts`) automatically routes tokens using on-chain signals (age, volume, holders, rugcheck, fee/TVL, bonding curve). DAMM Edge is evaluated first for very fresh tokens.

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
├── app/(dashboard)/                 ← Next.js dashboard (live-first from Meteora)
├── bot/
│   ├── scanner.ts
│   ├── scanner/                     ← deep-checker, lane classification, pool fetching
│   ├── monitor*.ts                  ← monitor orchestration + DLMM/DAMM implementations
│   ├── executor/                    ← split execution (open/close/add-liquidity/utils/persistence)
│   ├── damm-executor.ts
│   ├── alerter.ts
│   ├── telegram-bot.ts
│   └── orphan-detector.ts
├── strategies/                      ← Evil Panda, Scalp Spike, DAMM Edge, Stable, Bluechip, Moonboy
├── lib/
│   ├── strategy-config.ts           ← single source of truth for all env-driven tuning
│   ├── get-dashboard-data.ts        ← live Meteora snapshot + unstable_cache (dashboard)
│   ├── meteora-live.ts              ← live position state + PnL derivation
│   ├── solana-tx.ts                 ← shared tx simulation & sending
│   └── ...
├── supabase/migrations/
├── ecosystem.config.cjs
└── .env.local.example               ← comprehensive strategy & scanner tuning reference
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
pm2 start ecosystem.config.cjs --update-env
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
- [ ] `TELEGRAM_ALLOWED_USERS` set to your Telegram user id for command access
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

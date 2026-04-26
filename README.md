# Meteoracle

Automated on-chain liquidity provision bot for Solana. Scans Meteora DLMM pools in real time, classifies tokens by risk profile, deploys capital into concentrated liquidity positions, and manages exits — all without human intervention.

Built and operated as a solo project. Production-grade, self-hosted, zero external dependencies beyond public APIs.

**Stack:** TypeScript · Next.js 14 · Supabase (Postgres) · Solana web3.js · Meteora DLMM SDK · PM2 · Hetzner VPS

---

## What it does

1. **Scans** — A background process continuously polls Meteora DLMM pools, filtering candidates by liquidity, volume, age, holder distribution, and safety score.
2. **Classifies** — Each token is assigned a risk class by a multi-signal classifier that combines on-chain data, holder analysis, and market structure.
3. **Deploys** — Based on the risk class, the bot selects the appropriate strategy and opens a concentrated liquidity position on Meteora DLMM.
4. **Monitors** — A separate monitor process tracks each open position every minute: range status, fee accrual, price movement, and elapsed time.
5. **Exits** — Positions are closed automatically based on a set of configurable exit conditions. Fees are claimed before close.
6. **Alerts** — All events (opens, closes, rebalances, errors) are dispatched via Telegram in real time.

---

## Architecture

```
Hetzner VPS (PM2)
  │
  ├── bot/scanner.ts          ← pool scanner + token classifier + position opener
  ├── bot/monitor.ts          ← position health monitor + exit engine
  ├── bot/telegram-bot.ts     ← bidirectional Telegram command interface
  └── start-dashboard.sh      ← Next.js dashboard (port 3000)

Next.js Dashboard
  └── app/(dashboard)/
      ├── page.tsx            ← live KPIs, P&L chart, open positions table
      └── strategies/page.tsx ← strategy reference + per-strategy performance

Supabase (Postgres)
  ├── lp_positions            ← all positions, open and closed
  ├── candidates              ← every scanned token with full classifier output
  ├── bot_logs                ← structured event log
  └── bot_state               ← killswitch + runtime flags
```

---

## Strategies

The bot runs multiple strategies in parallel, each targeting a different token risk profile. Strategy selection is fully automatic — the classifier routes each token to the correct strategy based on real-time on-chain data.

Strategy parameters (entry filters, position sizing, range configuration, exit rules) live in `strategies/` and are not published here.

| Strategy | Type | Target |
|---|---|---|
| Evil Panda | DLMM LP | Early-stage, high-volatility memecoins |
| Scalp Spike | DLMM LP | Mid-cap tokens with sudden volume spikes |
| Stable Farm | DLMM LP | Established pairs, lower volatility |

---

## Dashboard

A private Next.js dashboard runs on the same VPS. It shows:

- Real-time open positions with fee accrual, P&L breakdown (fees vs. price impact), and time in position
- Closed position history with exit reasons
- Per-strategy performance metrics
- Bot status, wallet balance, and scan activity

The dashboard polls the bot's Supabase database directly — no separate API layer needed.

---

## Telegram interface

All bot events emit Telegram alerts. The bot also accepts inbound commands:

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
│   ├── scanner.ts             ← pool scanner + classifier + opener
│   ├── monitor.ts             ← position monitor + exit engine
│   ├── executor.ts            ← on-chain transaction execution
│   ├── alerter.ts             ← Telegram alert dispatcher
│   ├── scorer.ts              ← candidate scoring
│   ├── telegram-bot.ts        ← inbound command handler
│   ├── startup-alert.ts       ← crash-restart notification
│   └── orphan-detector.ts     ← reconciles DB vs on-chain state
├── strategies/
│   ├── index.ts               ← classifier + strategy registry
│   ├── evil-panda.ts
│   ├── scalp-spike.ts
│   └── stable-farm.ts
├── lib/
│   ├── supabase.ts
│   ├── solana.ts
│   ├── helius.ts
│   ├── rugcheck.ts
│   ├── pumpfun.ts
│   └── types.ts
├── supabase/migrations/       ← versioned schema migrations
├── ecosystem.config.cjs       ← PM2 process definitions
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

### 2. Supabase

Create a project at [supabase.com](https://supabase.com), then run the migrations in `supabase/migrations/` in order via the SQL editor. Seed the killswitch row:

```sql
insert into bot_state (id, enabled) values (1, true)
on conflict (id) do nothing;
```

### 3. Environment

```bash
cp .env.local.example .env.local
# fill in all required values
```

### 4. Deploy (PM2 on VPS)

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
git pull && pm2 restart all --update-env && pm2 save
```

---

## Go-live checklist

- [ ] All Supabase migrations applied
- [ ] `bot_state` row inserted
- [ ] Wallet funded (≥ 0.5 SOL recommended)
- [ ] `BOT_DRY_RUN=false` confirmed
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
| Hetzner VPS | Process hosting | CX22 ~€4/mo |

---

## Disclaimer

Experimental software. Liquidity provision on volatile assets carries significant risk including total loss of deployed capital. This project is published for portfolio and educational purposes. Run in dry-run mode (`BOT_DRY_RUN=true`) before deploying real funds.

# ⚡ Meteoracle

> Automated Solana trading bot with a live Next.js dashboard. Two active pipelines: pre-graduation pump.fun spot buys, and Meteora DLMM LP positions.

**Status:** Live — 7 bot processes on Hetzner VPS via PM2, dashboard on Coolify.

---

## Architecture

```
Hetzner VPS (PM2 — 7 processes)
  │
  ├── PIPELINE 1: Meteora DLMM LP
  │   ├── bot/scanner.ts          ← scans Meteora pools every 15min
  │   └── bot/monitor.ts          ← monitors LP range health + exits every 5min
  │
  ├── PIPELINE 2: Pre-grad spot buy (pump.fun)
  │   ├── bot/pre-grad-scanner.ts ← polls pump.fun every 60s (88–98% bonding curve)
  │   ├── bot/spot-buyer.ts       ← buys watchlist tokens via Jupiter every 30s
  │   └── bot/spot-monitor.ts     ← TP/SL/timeout exits every 30s
  │
  └── PIPELINE 3: Post-grad LP bridge
      ├── bot/lp-migrator.ts      ← detects graduation, opens Meteora DLMM LP
      └── bot/lp-monitor.ts       ← monitors post-grad LP positions

Coolify (Next.js dashboard — npm run start)
  └── app/(dashboard)/
      ├── page.tsx                ← KPIs, P&L chart, positions table, watchlist
      ├── strategies/page.tsx     ← Strategy config + live performance
      ├── bot/page.tsx            ← Process health, open positions, recent exits
      └── settings/page.tsx       ← Env var reference + go-live checklist

Supabase (Postgres)
  ├── pre_grad_watchlist          ← tokens detected by pre-grad scanner
  ├── spot_positions              ← all pre-grad trades (open + closed)
  ├── positions                   ← all LP positions (open + closed)
  ├── candidates                  ← Meteora scanner candidates log
  └── bot_logs                    ← structured event log

Telegram — outbound alerts only
```

---

## Pipeline 1 — Meteora DLMM LP

Scans all Meteora pools every 15 minutes. Filters by market cap, volume, liquidity, age, holder count, rugcheck score. Opens a DLMM LP position with a tight bin range centered at current price. Monitors range health every 5 minutes — smart-rebalances if price drifts >30% inside range, closes on stop-loss / take-profit / max duration / out-of-range timeout.

## Pipeline 2 — Pre-grad Spot Buy

Scans pump.fun tokens at 88–98% bonding curve progress every 60 seconds. Enriches each candidate with pump.fun API data: bonding curve %, holder count, top holder %, dev wallet %. Buys via Jupiter v6. Exits at +150% TP, -35% SL, or 90-minute timeout.

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

Detects pump.fun graduation events, then opens a Meteora DLMM LP position for the newly listed token. Monitors LP health and exits on the same conditions as Pipeline 1.

---

## Repo structure

```
meteoracle/
├── app/
│   └── (dashboard)/            ← All Next.js pages (shared layout)
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
├── ecosystem.config.cjs        ← PM2 config (all 7 processes)
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

### 5. Deploy dashboard (Coolify)

- Build command: `npm run build`
- Start command: `npm run start`
- Add all env vars from `.env.local.example` in Coolify environment settings
- Only `NEXT_PUBLIC_*`, `SUPABASE_SERVICE_ROLE_KEY`, and `TELEGRAM_*` vars are needed by the dashboard

### 6. Run bots on VPS (PM2)

```bash
# On your VPS
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
cp .env.local.example .env.local   # fill in your values
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command — survives reboots
```

Check status:
```bash
pm2 status
pm2 logs scanner --lines 50
pm2 logs buyer --lines 50
pm2 logs monitor --lines 50
```

Update after a code push:
```bash
git pull && npm install && pm2 restart all
```

---

## Go-live checklist

- [ ] All 4 Supabase migrations applied
- [ ] Wallet funded (≥ 0.5 SOL — covers positions + gas)
- [ ] `BOT_DRY_RUN=false` in `.env.local` on VPS
- [ ] `BITQUERY_API_KEY` set (pre-grad scanner requires it)
- [ ] PM2 started and saved: `pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`
- [ ] Telegram alert fires on first live buy
- [ ] Dashboard accessible via Coolify domain

---

## Telegram alerts

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

---

## Required accounts

- [Helius](https://helius.dev) — Solana RPC (free tier fine)
- [Bitquery](https://account.bitquery.io/user/api_v2_keys) — EAP v2 key for pre-grad scanner
- [Supabase](https://supabase.com) — Postgres DB (free tier fine)
- [Rugcheck](https://rugcheck.xyz) — token safety scores (no key needed)
- Telegram bot via @BotFather
- Hetzner VPS (CX22 recommended — ~€4/mo)

---

## Disclaimer

Experimental software. Meme token and LP trading is extremely high risk. Never deploy funds you cannot afford to lose entirely. Always validate in dry-run mode first.

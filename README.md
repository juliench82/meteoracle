# ⚡ Meteoracle

> Automated pre-graduation spot-buy bot for pump.fun tokens on Solana, with a live Next.js dashboard.

Meteoracle watches pump.fun tokens approaching graduation (80–99% bonding curve), buys them via Jupiter v6, and exits at +200% TP, -40% SL, or after 4 hours. A Next.js dashboard on Vercel shows live positions, P&L, and watchlist. Alerts and control run via Telegram.

**Status:** Live — bots running on Hetzner VPS via PM2, dashboard on Vercel.

---

## Strategy: Pre-Grad Spot Buy

### The edge

Tokens graduating from pump.fun's bonding curve get listed on Raydium immediately after. That listing event creates a price spike as new buyers discover the token. The edge is buying *just before* graduation (80–99% bonding progress), riding the spike, and exiting fast before it fades.

### Signal (Scanner)

Every 60 seconds the scanner calls the pump.fun API and filters tokens that match **all** of:

| Filter | Default | Env var |
|---|---|---|
| Bonding curve progress | 80% – 99% | `PRE_GRAD_MIN_BONDING_PCT` / `PRE_GRAD_MAX_BONDING_PCT` |
| Volume (last 5 min) | ≥ 5 SOL | `PRE_GRAD_MIN_VOL_5MIN_SOL` |
| Holders | ≥ 50 | `PRE_GRAD_MIN_HOLDERS` |
| Top holder concentration | ≤ 20% | `PRE_GRAD_MAX_TOP_HOLDER` |

Tokens that pass are added to `pre_grad_watchlist` with `status = 'watching'`.

### Entry (Buyer)

Every 30 seconds the buyer reads the watchlist and for each `watching` token:

1. Re-checks volume filter
2. Dedup guard — skips if already have an open position for that mint
3. Capital guard — skips if already at `MAX_CONCURRENT_SPOTS` or `MAX_TOTAL_SPOT_SOL`
4. Wallet balance guard — skips if SOL balance < buy size + 0.05 buffer
5. Fetches Jupiter quote → executes swap → stores `entry_price_usd` from Jupiter Price API
6. Inserts row into `spot_positions`, updates watchlist to `opened`
7. Fires Telegram alert: 🟢 BUY token | size | TP | SL | entry price

| Position config | Default | Env var |
|---|---|---|
| Buy size | 0.05 SOL | `SPOT_BUY_SOL` |
| Max concurrent | 3 | `MAX_CONCURRENT_SPOTS` |
| Max total capital | 0.15 SOL | `MAX_TOTAL_SPOT_SOL` |
| Slippage | 300 bps | `SPOT_BUY_SLIPPAGE_BPS` |

### Exit (Monitor)

Every 30 seconds the monitor fetches all `open` positions and checks each one:

- **Live mode:** fetches current USD price from Jupiter Price API, compares to `entry_price_usd`
- **Dry-run mode:** simulates a random price walk (±15% per tick)

Exit triggers (first to fire wins):

| Condition | Default | Env var |
|---|---|---|
| Take profit | +200% | `PRE_GRAD_TP_PCT` |
| Stop loss | -40% | `PRE_GRAD_SL_PCT` |
| Max hold time | 240 min | `PRE_GRAD_MAX_HOLD_MIN` |

On exit: calls spot-seller → updates `spot_positions` (status, `closed_at`, `pnl_sol`, `tx_sell`) → Telegram alert.

### Expected trade profile

```
Avg hold:    15–60 min
Win rate:    ~30–40% (high reward:risk compensates)
Avg winner:  +1x to +3x on buy size
Avg loser:   -40% on buy size (hard floor)
Max loss/trade: 0.02 SOL (at 0.05 SOL size)
```

The bet is asymmetric: losers are capped at -40%, winners can run to +200%+. One ONLYFANS-type trade (+215%) covers ~5 stop-losses.

---

## Architecture

```
Hetzner VPS (PM2)
  ├── bot/pre-grad-scanner.ts   ← polls pump.fun every 60s → pre_grad_watchlist
  ├── bot/spot-buyer.ts         ← polls watchlist every 30s → buys via Jupiter
  └── bot/spot-monitor.ts       ← polls open positions every 30s → TP/SL/timeout exits

Vercel (Next.js dashboard)
  └── app/(dashboard)/
      ├── page.tsx              ← KPIs, P&L chart, positions table, watchlist
      ├── strategies/           ← Strategy config + live performance stats
      ├── bot/                  ← Process health, open positions, recent exits
      └── settings/             ← Env var reference, Telegram commands

Supabase (Postgres)
  ├── pre_grad_watchlist        ← tokens detected by scanner
  └── spot_positions            ← all open and closed trades

Telegram
  └── Outbound alerts only (buy, sell, low balance, errors)
```

### Data flow

```
pump.fun API
     │
     ▼
pre-grad-scanner.ts  →  pre_grad_watchlist (status: watching)
                                │
                                ▼
                        spot-buyer.ts  →  Jupiter swap  →  spot_positions (status: open)
                                                                    │
                                                                    ▼
                                                           spot-monitor.ts  →  spot-seller.ts
                                                                                    │
                                                                                    ▼
                                                                           spot_positions (status: closed_tp / closed_sl)
```

---

## Repo structure

```
meteoracle/
├── app/
│   ├── (dashboard)/            ← All dashboard pages (shared Sidebar + Header layout)
│   │   ├── page.tsx            ← Dashboard home
│   │   ├── strategies/page.tsx
│   │   ├── bot/page.tsx
│   │   └── settings/page.tsx
│   ├── api/telegram/webhook/   ← Legacy Telegram command handler
│   ├── layout.tsx
│   └── globals.css
├── bot/
│   ├── pre-grad-scanner.ts     ← Scanner (long-running)
│   ├── spot-buyer.ts           ← Buyer (long-running)
│   ├── spot-monitor.ts         ← Monitor (long-running)
│   ├── spot-seller.ts          ← Jupiter sell helper
│   └── telegram.ts             ← Outbound Telegram alerts
├── components/
│   ├── layout/                 ← Sidebar, Header
│   └── dashboard/              ← SpotKPIBar, SpotPositionsTable, WatchlistFeed, SpotPnlChart
├── strategies/
│   └── pre-grad.ts             ← Strategy config (all tunable via env vars)
├── lib/
│   ├── supabase.ts
│   └── types.ts
├── supabase/migrations/
│   ├── 001_initial_schema.sql
│   └── 002_entry_price_usd.sql
└── ecosystem.config.cjs        ← PM2 process config
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

Run both migrations in the Supabase SQL editor:

```sql
-- 001: initial schema (pre_grad_watchlist, spot_positions)
-- paste contents of supabase/migrations/001_initial_schema.sql

-- 002: add entry_price_usd
ALTER TABLE spot_positions ADD COLUMN IF NOT EXISTS entry_price_usd NUMERIC DEFAULT 0;
```

### 3. Environment variables

Create `.env.local`:

```env
# --- Supabase ---
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# --- Solana ---
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PRIVATE_KEY=           # base58 private key — keep secret

# --- Telegram ---
TELEGRAM_BOT_TOKEN=           # from @BotFather
TELEGRAM_CHAT_ID=             # your personal chat ID

# --- Bot control ---
BOT_DRY_RUN=true              # set to false for live trading
MIN_WALLET_BALANCE_SOL=0.05   # SOL buffer — never buy below this

# --- Strategy tuning (all optional, defaults shown) ---
SPOT_BUY_SOL=0.05
MAX_CONCURRENT_SPOTS=3
MAX_TOTAL_SPOT_SOL=0.15
SPOT_BUY_SLIPPAGE_BPS=300
SPOT_BUYER_POLL_SEC=30
SPOT_MONITOR_POLL_SEC=30

PRE_GRAD_MIN_BONDING_PCT=80
PRE_GRAD_MAX_BONDING_PCT=99
PRE_GRAD_MIN_VOL_5MIN_SOL=5
PRE_GRAD_MIN_HOLDERS=50
PRE_GRAD_MAX_TOP_HOLDER=20
PRE_GRAD_TP_PCT=200
PRE_GRAD_SL_PCT=-40
PRE_GRAD_MAX_HOLD_MIN=240
```

### 4. Run locally (dry-run first)

```bash
# Dashboard
npm run dev

# Bots (3 separate terminals)
npx tsx bot/pre-grad-scanner.ts
npx tsx bot/spot-buyer.ts
npx tsx bot/spot-monitor.ts
```

Watch Telegram for alerts. Check Supabase for rows appearing in `pre_grad_watchlist` and `spot_positions`.

### 5. Deploy dashboard to Vercel

```bash
npx vercel --prod
```

Add all env vars in the Vercel dashboard (Settings → Environment Variables).

### 6. Run bots on Hetzner VPS (production)

```bash
# On your VPS
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
cp .env.local.example .env.local   # fill in your values

npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to survive reboots
```

Check status:
```bash
pm2 status
pm2 logs scanner --lines 50
pm2 logs buyer --lines 50
pm2 logs monitor --lines 50
```

To update after a code push:
```bash
git pull && pm2 restart all
```

---

## Go-live checklist

- [ ] Migration 002 applied in Supabase SQL editor
- [ ] Wallet funded (0.5 SOL minimum — covers 3 positions + gas)
- [ ] `BOT_DRY_RUN=false` in `.env.local` on VPS
- [ ] PM2 started: `pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`
- [ ] Telegram alert fires on first live buy ✅

---

## Telegram alerts (outbound only)

| Alert | Trigger |
|---|---|
| 🟢 BUY token | Position opened |
| 🟡 [DRY-RUN] BUY token | Dry-run position opened |
| 🟢 CLOSED token TP ✅ | Take profit hit |
| 🔴 CLOSED token SL ❌ | Stop loss hit |
| ⏱️ CLOSED token TIMEOUT | Max hold exceeded |
| ⚠️ LOW BALANCE | Wallet too low to buy |
| ❌ BUY FAILED | Jupiter swap error |

---

## Required accounts (all free)

- [ ] [Helius](https://helius.dev) — Solana RPC
- [ ] [Supabase](https://supabase.com) — Postgres DB
- [ ] [Vercel](https://vercel.com) — Dashboard hosting
- [ ] Telegram bot via @BotFather
- [ ] Hetzner VPS (cheapest CX11 is fine — ~€4/mo)

---

## Roadmap

| | |
|---|---|
| ✅ Day 1 | Supabase schema, pump.fun scanner |
| ✅ Day 2 | spot-buyer.ts — Jupiter v6 buys |
| ✅ Day 3 | spot-monitor.ts — TP/SL/timeout exits |
| ✅ Day 4 | spot-seller.ts — Jupiter sell execution |
| ✅ Day 5 | Live hardening: entry_price_usd, wallet guard, Telegram alerts |
| ✅ Day 6 | Dashboard wired: KPIs, P&L chart, positions table, watchlist, all nav pages |
| 🔜 Day 7 | Post-grad LP bridge — detect graduation event, deploy into Meteora DLMM |

---

## Disclaimer

Experimental software. Meme token trading is extremely high risk. Never deploy funds you cannot afford to lose entirely. Always validate in dry-run mode before enabling live trading. Past dry-run results do not predict live performance.

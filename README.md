# 🌩️ Meteoracle

> Multi-strategy Meteora DLMM LP automation bot with live dashboard

Meteoracle is a strategy-driven liquidity providing bot for [Meteora DLMM](https://meteora.ag) on Solana. It scans Solana memecoins, classifies them into strategy buckets, deploys DLMM positions automatically when filters match, monitors range health, and closes positions when exit conditions trigger.

**Status:** Active development — strategies running locally, dashboard live on Vercel.

---

## Architecture

```
metéoracle/
├── app/                          ← Next.js 14 App Router
│   ├── page.tsx                  ← Dashboard home
│   ├── layout.tsx
│   ├── globals.css
│   └── api/
│       ├── telegram/webhook/     ← Telegram bot commands
│       ├── bot/tick/             ← Vercel cron endpoint
│       ├── positions/            ← Positions REST API
│       ├── positions/pnl/        ← PnL calculations
│       ├── candidates/           ← Scan candidates API
│       └── strategies/           ← Strategy registry API
├── bot/
│   ├── scanner.ts                ← Meteora pool fetching + scoring
│   ├── scorer.ts                 ← Filter + score logic
│   ├── executor.ts               ← Meteora DLMM SDK — open/close positions
│   ├── monitor.ts                ← Range health checks + auto-exit
│   ├── run-scanner.mjs           ← Local CLI runner (scanner)
│   └── run-monitor.mjs           ← Local CLI runner (monitor)
├── components/
│   ├── layout/
│   ├── dashboard/
│   └── ui/
├── lib/
│   ├── types.ts                  ← Shared TypeScript interfaces
│   ├── supabase.ts               ← Supabase client
│   ├── solana.ts                 ← RPC connection + wallet + priority fees
│   └── botState.ts               ← Bot enabled/dry-run state (Supabase-backed)
├── strategies/
│   ├── index.ts                  ← Strategy registry + matcher
│   ├── evil-panda.ts             ← Evil Panda strategy
│   ├── scalp-spike.ts            ← Scalp Spike strategy
│   └── stable-farm.ts            ← Stable Farm strategy
└── supabase/
    └── migrations/
        └── 001_initial_schema.sql
```

---

## Tech Stack

| Layer | Tool | Cost |
|---|---|---|
| Frontend + API | Next.js 14 on Vercel (Hobby) | Free |
| Database | Supabase (Postgres) | Free tier |
| Solana RPC | Helius | Free tier |
| Pool data | Meteora datapi (`dlmm.datapi.meteora.ag`) | Free |
| Token metadata | DexScreener API | Free, no key |
| Rug checks | rugcheck.xyz API | Free |
| Alerts + control | Telegram Bot API | Free |
| LP execution | `@meteora-ag/dlmm` SDK | Open-source |

---

## Strategies

### Evil Panda
Wide-range fee farming on high-volume Solana memecoins. Deploys single-sided SOL into −80%/+20% bin ranges. Accumulates fees through volatility, exits when volume dies or stop-loss/take-profit triggers.

| Filter | Value |
|---|---|
| Market cap | $200K – $50M |
| Volume 24h | > $40K |
| Liquidity | > $20K |
| Max age | 120h |
| Rugcheck score | ≥ 40 |
| Max top holder | 25% |

| Exit condition | Value |
|---|---|
| Stop loss | −90% |
| Take profit | +300% |
| Out of range | 120 min |
| Max duration | 48h |

### Scalp Spike
Short-duration spike catcher on high-volume low-cap tokens. Tight ranges, fast exits.

### Stable Farm
Low-risk fee farming on larger established pairs with high liquidity.

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Helius RPC
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Solana wallet (base58 private key)
WALLET_PRIVATE_KEY=

# Telegram bot
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Bot control
BOT_ENABLED=true
BOT_DRY_RUN=true           # set to false for live trading
MAX_CONCURRENT_POSITIONS=1
MAX_SOL_PER_POSITION=0.1
```

### 3. Set up Supabase

Run the migration in `supabase/migrations/001_initial_schema.sql` via the Supabase SQL editor.

### 4. Run locally

```bash
# Development dashboard
npm run dev

# Run scanner once (finds candidates, opens positions)
npx tsx bot/run-scanner.mjs

# Run monitor once (checks open positions, triggers exits)
npx tsx bot/run-monitor.mjs
```

### 5. Schedule locally (WSL/Linux cron)

For reliable execution without Vercel plan constraints, run via cron:

```bash
crontab -e
```

```
# Scanner every 15 minutes
*/15 * * * * cd /path/to/meteoracle && npx tsx bot/run-scanner.mjs >> /tmp/meteoracle-scan.log 2>&1

# Monitor every 5 minutes
*/5 * * * * cd /path/to/meteoracle && npx tsx bot/run-monitor.mjs >> /tmp/meteoracle-monitor.log 2>&1
```

Make sure cron is running:
```bash
sudo service cron start
```

### 6. Deploy dashboard to Vercel

```bash
npx vercel --prod
```

Add all env vars in the Vercel dashboard. The dashboard, `/status`, and Telegram control commands (`/start`, `/stop`, `/dry`, `/live`, `/status`) all work within Vercel's 10s Hobby limit. Heavy scan/monitor runs are best executed locally.

---

## Telegram Commands

| Command | Description |
|---|---|
| `/scan` | Scan for new candidates & open positions |
| `/monitor` | Check open positions, trigger exits/rebalances |
| `/tick` | Run scan + monitor together |
| `/start` | Resume the bot |
| `/stop` | Pause all scanning & monitoring |
| `/dry` | Switch to dry-run (no real trades) |
| `/live` | Switch to live trading |
| `/status` | Show current state, positions, last tick |
| `/help` | Show command list |

> **Note:** On Vercel Hobby plan, `/scan`, `/monitor`, and `/tick` will time out (10s limit). Use local cron for reliable execution.

---

## Required Accounts (all free)

- [ ] [Helius](https://helius.dev) — Solana RPC
- [ ] [Supabase](https://supabase.com) — Postgres DB
- [ ] [Vercel](https://vercel.com) — Dashboard hosting
- [ ] Telegram — Bot token via @BotFather

---

## Disclaimer

This is experimental software. Liquidity provision and trading automation carries significant financial risk. Never deposit funds you cannot afford to lose. Always validate strategies in dry-run mode before enabling live trading.

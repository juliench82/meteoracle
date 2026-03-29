# 🌩️ Meteoracle

> Multi-strategy Meteora DLMM LP automation bot with live dashboard

Meteoracle is a strategy-driven liquidity providing bot for [Meteora DLMM](https://meteora.ag) on Solana. It scans memecoins, classifies them into strategy buckets, deploys positions automatically when filters match, monitors range health, and closes or rebalances positions when exit conditions trigger.

---

## Architecture

```
meteoracle/
├── app/                    ← Next.js 14 App Router
│   ├── page.tsx            ← Dashboard home
│   ├── globals.css
│   ├── layout.tsx
│   └── api/
│       ├── bot/tick/       ← Cron endpoint
│       ├── positions/      ← REST stubs
│       ├── candidates/
│       └── strategies/
├── bot/
│   ├── scanner.ts          ← DexScreener polling
│   ├── scorer.ts           ← Filter + score logic
│   ├── executor.ts         ← Meteora SDK calls
│   └── monitor.ts          ← Position range checks
├── components/
│   ├── layout/
│   ├── dashboard/
│   └── ui/
├── lib/
│   ├── types.ts            ← Shared interfaces
│   ├── supabase.ts
│   └── redis.ts            ← Vercel KV wrapper
├── strategies/
│   ├── index.ts            ← Strategy registry
│   └── evil-panda.ts       ← Evil Panda strategy
└── supabase/
    └── migrations/
        └── 001_initial_schema.sql
```

---

## Tech Stack

| Layer | Tool | Cost |
|---|---|---|
| Frontend + API | Next.js 14 on Vercel | Free |
| Database | Supabase (Postgres) | Free tier |
| Cache / KV | Vercel KV (Redis) | Free tier |
| Solana RPC | Helius | Free tier |
| Token scanning | DexScreener API | Free, no key |
| Rug checks | rugcheck.xyz API | Free |
| Alerts | Telegram Bot API | Free |
| LP execution | `@meteora-ag/dlmm` SDK | Open-source |

---

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Production dashboard |
| `feat/scanner` | DexScreener scanner module |
| `feat/strategies` | Strategy engine + filters |
| `feat/executor` | Meteora SDK position execution |
| `feat/monitor` | Position monitoring + auto-close |

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in your keys:

```bash
cp .env.example .env.local
```

### 3. Set up Supabase

Run the migration in `supabase/migrations/001_initial_schema.sql` via the Supabase SQL editor.

### 4. Run locally

```bash
npm run dev
```

### 5. Deploy to Vercel

```bash
npx vercel --prod
```

Add all env vars from `.env.example` in the Vercel dashboard.

---

## Required Accounts (all free)

- [ ] [Helius](https://helius.dev) — Solana RPC key
- [ ] [Supabase](https://supabase.com) — Postgres DB
- [ ] [Vercel](https://vercel.com) — Hosting + KV + Cron
- [ ] Telegram — Bot token via @BotFather

---

## Strategies

### Evil Panda
Wide-range (−70% to −95%) fee farming on high-volume memecoins. Accumulates SOL via fees even during price drawdowns. Uses single-sided SOL deposits and holds through volatility.

More strategies will be added in `feat/strategies`.

---

## Disclaimer

This is experimental software. Trading and LP automation carries significant financial risk. Never deposit funds you cannot afford to lose. Always test on devnet first.

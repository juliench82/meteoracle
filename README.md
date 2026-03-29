# 🔮 Meteoracle

A strategy-driven LP automation bot for [Meteora DLMM](https://meteora.ag) on Solana.

Meteoracle scans memecoins and DeFi tokens, classifies them into strategy buckets, opens Meteora DLMM positions when filters match, monitors range/fees/risk, and closes or rebalances automatically when conditions break.

---

## Architecture

```
meteoracle/
├── app/                     ← Next.js 14 App Router (dashboard + API routes)
├── bot/                     ← Scanner, scorer, executor, monitor (worker logic)
├── strategies/              ← Strategy registry (evil-panda, scalp-spike, etc.)
├── components/              ← Dashboard UI components
├── lib/                     ← Supabase, Redis, shared types
└── supabase/migrations/     ← DB schema
```

### Layers

| Layer | What it does |
|---|---|
| **Bot Engine** | Background worker: scans tokens, scores, opens/closes positions |
| **API Routes** | Next.js edge functions bridging bot state and dashboard |
| **Dashboard** | Real-time position monitor, candidate feed, strategy config |

---

## Tech Stack

| Tool | Purpose | Cost |
|---|---|---|
| [Vercel](https://vercel.com) | Hosting + Cron Jobs | Free |
| [Supabase](https://supabase.com) | Postgres DB + Realtime | Free (500MB) |
| [Vercel KV](https://vercel.com/storage/kv) | Redis cache + pub/sub | Free tier |
| [Helius](https://helius.dev) | Solana RPC | Free (100k req/day) |
| [DexScreener API](https://docs.dexscreener.com) | Token scanning | Free, no key |
| [Rugcheck.xyz](https://rugcheck.xyz) | Rug risk scoring | Free |
| Meteora DLMM SDK | On-chain LP execution | Open-source |

---

## Strategies

Each strategy is a self-contained TypeScript config in `strategies/`. A token is matched to at most one strategy per scan cycle — the highest-scoring match wins.

| Strategy | Target | Range | Bias |
|---|---|---|---|
| **Evil Panda** | High-volume memecoins | −70% to −95% wide | SOL-sided |
| **Scalp Spike** | New launches with spike | ±10% narrow | Neutral |
| **Stable Farm** | Stable/blue-chip pairs | ±2% tight | Balanced |

---

## Branch Strategy

```
main              ← Production dashboard (always deployable)
feat/scanner      ← DexScreener + Helius scanner
feat/strategies   ← Strategy engine + scorer
feat/executor     ← Meteora SDK execution layer
feat/monitor      ← Position range check + auto-close
```

Every feature is built on a branch, reviewed, then merged to `main`.

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/juliench82/meteoracle.git
cd meteoracle
npm install
```

### 2. Create accounts (all free)

- [Helius](https://helius.dev) — Solana RPC key
- [Supabase](https://supabase.com) — new project
- [Vercel](https://vercel.com) — connect repo, enable KV storage

### 3. Configure environment

Copy `.env.example` to `.env.local` and fill in your values.

### 4. Run database migrations

```bash
# In Supabase SQL editor, run:
supabase/migrations/001_initial_schema.sql
```

### 5. Run locally

```bash
npm run dev
```

---

## Environment Variables

See `.env.example` for all required variables.

| Variable | Description |
|---|---|
| `HELIUS_RPC_URL` | Solana RPC endpoint from Helius |
| `WALLET_PRIVATE_KEY` | Bot wallet private key (base58) — keep secret! |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (server-side only) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL (client-safe) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (client-safe) |
| `KV_URL` | Vercel KV Redis URL |
| `KV_REST_API_URL` | Vercel KV REST URL |
| `KV_REST_API_TOKEN` | Vercel KV token |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (optional alerts) |
| `TELEGRAM_CHAT_ID` | Telegram chat ID (optional alerts) |

---

## ⚠️ Disclaimer

This is experimental software. Trading and LP provision carry significant financial risk. Always test on devnet before using real funds. Never commit your private key.

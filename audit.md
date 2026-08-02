# Meteoracle — Repository Audit Report

## 1. Overview & Architecture

Meteoracle is a Solana-based automated liquidity-provisioning (LP) bot targeting Meteora DLMM pools. It follows a three-stage pipeline:

**Scanner → Executor → Monitor**, backed by a local JSON state store and a Telegram bot for alerts/control.

bot/
 ├─ scanner.ts + scanner/ (deep-checker, pool-fetcher, pool-metrics, activity-candidate-filter)
 ├─ executor.ts + executor/ (open.ts, open/bin-calc.ts, open/pre-swap.ts, close.ts, add-liquidity.ts, persistence.ts, utils.ts)
 ├─ monitor.ts
 ├─ alerter.ts
 ├─ telegram-bot.ts
 └─ rugcheck-cache.ts
lib/
 ├─ solana.ts, swap.ts, helius.ts, rugcheck.ts
 ├─ strategy-config.ts, botState.ts, local-state.ts
 ├─ circuit-breaker.ts, position-limits.ts
 ├─ startup-validation.ts, telegram-auth.ts
strategies/
 └─ evil-panda.ts
worker.ts        // entry point / orchestration loop
ecosystem.config.cjs   // PM2 process config

The system runs as a long-lived worker process (PM2-managed) that repeatedly scans pools, opens positions per a configured strategy ("evil-panda" Bid-Ask), monitors open positions for exit conditions, and closes/reports via Telegram.

## 2. File Roles

| File | Role |
|---|---|
| `worker.ts` | Main loop: runs startup validation, then cycles scanner → executor → monitor |
| `bot/scanner.ts` | Orchestrates pool discovery pipeline |
| `bot/scanner/pool-fetcher.ts` | Pulls raw pool list from Meteora/DLMM API |
| `bot/scanner/pool-metrics.ts` | Computes TVL, fee/TVL ratio, volume metrics per pool |
| `bot/scanner/activity-candidate-filter.ts` | Filters pools by activity/volume thresholds |
| `bot/scanner/deep-checker.ts` | Deeper due-diligence checks (rugcheck, liquidity distribution) before candidacy |
| `bot/rugcheck-cache.ts` / `lib/rugcheck.ts` | Caches and queries token safety/rugcheck scores |
| `strategies/evil-panda.ts` | Strategy definition: Bid-Ask LP with defined bin range, entry/exit fee-TVL ratios |
| `bot/executor.ts` | Coordinates opening positions based on scanner candidates + strategy config |
| `bot/executor/open.ts` | Core "open position" flow (assembles instructions, calls bin-calc, pre-swap) |
| `bot/executor/open/bin-calc.ts` | Computes discrete bin range (Math.round to match Meteora UI) and hard-gates against paying non-refundable rent for new bin arrays |
| `bot/executor/open/pre-swap.ts` | Pre-position token swap/balancing logic |
| `bot/executor/add-liquidity.ts` | Adds liquidity to an existing position |
| `bot/executor/close.ts` | Closes a position, withdraws liquidity/fees |
| `bot/executor/persistence.ts` | Persists position/trade state after execution |
| `lib/local-state.ts` | Local JSON-file-based state store (positions, history) |
| `lib/botState.ts` | In-memory bot state/singleton helpers |
| `bot/monitor.ts` | Polls open positions, evaluates exit conditions (fee/TVL decay, stop conditions), triggers close |
| `bot/alerter.ts` | Sends formatted alerts (Telegram) on key events |
| `bot/telegram-bot.ts` | Telegram bot command handling (status, control commands) |
| `lib/telegram-auth.ts` | Validates authorized Telegram chat/user IDs |
| `lib/solana.ts` | Wallet + Connection singleton getters |
| `lib/swap.ts` | Jupiter-based token swap execution |
| `lib/helius.ts` | Helius RPC/webhook integration helpers |
| `lib/strategy-config.ts` | Central strategy constants (e.g., `LP_FEE_TVL_EXIT_THRESHOLD`, `MIN_FEE_TVL_RATIO_24H`) |
| `lib/circuit-breaker.ts` | Halts trading after consecutive failures/losses |
| `lib/position-limits.ts` | Enforces max concurrent positions / exposure caps |
| `lib/startup-validation.ts` | Pre-flight checks (RPC reachability, wallet balance, config sanity) — non-fatal, logs + returns boolean |
| `package.json` | Dependencies: `@solana/web3.js`, `@meteora-ag/dlmm`, `bn.js`, Jupiter swap SDK, Telegram bot library |
| `ecosystem.config.cjs` | PM2 process definition for production deployment |
| `.env.local.example` | Documents required environment variables |
| `README.md` / `AGENTS.md` | Project overview and AI-agent operating rules (repo interaction constraints, brevity rules) |

## 3. Scanner Pipeline

1. **`pool-fetcher.ts`** retrieves the current list of Meteora DLMM pools.
2. **`pool-metrics.ts`** computes per-pool metrics: TVL, 24h fees, fee/TVL ratio, volume.
3. **`activity-candidate-filter.ts`** filters down to pools meeting a minimum activity/fee-TVL bar (`MIN_FEE_TVL_RATIO_24H` from `strategy-config.ts`).
4. **`deep-checker.ts`** runs deeper vetting on remaining candidates — token safety via `rugcheck.ts`/`rugcheck-cache.ts`, and likely liquidity/bin distribution sanity.
5. Surviving candidates are handed to the executor for position opening.

## 4. Executor Flow (Open)

1. `executor.ts` receives a vetted candidate + strategy parameters.
2. `open/bin-calc.ts` computes the discrete bin range (target roughly -50%/+100% per the evil-panda config), using `Math.round()` to mirror Meteora's UI math.
3. **Critical safety gate**: `assertNoNewBinArraysForRange()` queries on-chain state via `getBinArraysRequiredByPositionRange` and **hard-aborts** if any required bin array is missing — this prevents the bot from paying non-refundable rent to initialize new bin arrays on thin/new pools.
4. `open/pre-swap.ts` rebalances the wallet's token composition ahead of deposit if needed (via `lib/swap.ts`, Jupiter).
5. `open.ts` assembles and submits the position-open transaction.
6. `executor/persistence.ts` writes the new position into local state (`lib/local-state.ts`).
7. `alerter.ts` sends a Telegram notification of the new position.

## 5. Monitor / Exit Logic

- `bot/monitor.ts` polls all open positions on an interval.
- Exit is triggered when the position's live fee/TVL ratio falls below `LP_FEE_TVL_EXIT_THRESHOLD` (from `strategy-config.ts`), or other stop conditions (e.g., stale/inactive pool, rug flags).
- A critical config invariant enforced in `startup-validation.ts`: **`LP_FEE_TVL_EXIT_THRESHOLD` must be strictly less than `MIN_FEE_TVL_RATIO_24H * 100`** (entry threshold). If violated, the bot logs a `CONFIG WARNING` and startup validation returns `false`, since a misconfigured pair would cause immediate open→close churn and fee burn.
- On trigger, `executor/close.ts` withdraws liquidity + fees and closes the position account; `persistence.ts` updates local state; `alerter.ts` reports the close (PnL, fees earned) via Telegram.
- `circuit-breaker.ts` tracks consecutive failures/losses and can pause new position opens if thresholds are breached.
- `position-limits.ts` caps concurrent open positions to bound capital exposure.

## 6. State Persistence

- **`lib/local-state.ts`**: file-based JSON persistence (no external DB) storing active positions and historical trade records.
- **`lib/botState.ts`**: in-memory runtime state (e.g., circuit-breaker counters, cached scan results) that doesn't need to survive restarts.
- **`bot/rugcheck-cache.ts`**: caches rugcheck API responses to avoid redundant calls and rate-limiting.

This gives the bot durability across restarts (positions aren't "lost" on process crash/restart) while keeping hot-path state fast and in-memory.

## 7. Environment Variables (per `.env.local.example` / code references)

- Solana RPC/wallet: RPC endpoint URL, wallet private key or keypair path
- `JUPITER_QUOTE_API_URL` — optional; if unset, the bot warns it's falling back to the **public** Jupiter endpoint, which risks rate limits and "stranded sells" during close cascades under load
- Helius API key (for enhanced RPC/webhooks)
- Telegram bot token + authorized chat/user ID(s) (`telegram-auth.ts`)
- Rugcheck API credentials (if required)
- Strategy tunables surfaced as env-configurable constants feeding `strategy-config.ts` (e.g., f

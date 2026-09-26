# Meteoracle — Repository Audit Report

## 1. Overview & Architecture

Meteoracle is a Solana-based automated liquidity-provisioning (LP) bot targeting **Meteora DLMM pools**. It follows a three-stage pipeline — **Scanner → Executor → Monitor** — backed by local JSON-file state and a Telegram bot for full control/observability. It is deliberately scoped to *pure one-sided SOL DLMM LP* on the "Evil Panda" top-performer strategy: no dashboard, no multi-strategy system, no external database, no on-chain position syncing/rebalancing.

bot/
├─ scanner.ts + scanner/ (pool-fetcher, pool-metrics, activity-candidate-filter, deep-checker)
├─ executor.ts (barrel) + executor/ (open.ts, open/bin-calc.ts, open/pre-swap.ts, close.ts, add-liquidity.ts, persistence.ts, utils.ts)
├─ monitor.ts
├─ alerter.ts
├─ telegram-bot.ts
└─ rugcheck-cache.ts
lib/
├─ solana.ts, swap.ts, helius.ts, rugcheck.ts, pumpfun.ts
├─ strategy-config.ts, botState.ts, local-state.ts, atomic-write.ts
├─ circuit-breaker.ts, position-limits.ts
├─ startup-validation.ts, telegram-auth.ts, sol-price.ts, rpc-rate-limit.ts, solana-tx.ts
├─ types.ts, log.ts, logging.ts
strategies/
└─ evil-panda.ts (+ index.ts)
scripts/            // one-off recovery/dev tools, not part of the live pipeline
worker.ts           // entry point / orchestration loop
ecosystem.config.cjs // PM2 process config (worker + telegram bot)

The system runs as a **long-lived worker process** (PM2-managed, `dist/worker.js`) that on a recursive-`setTimeout` schedule (not `setInterval`, to avoid tick overlap) runs the monitor every ~60s and the scanner every ~15min, opens positions per the "evil-panda" Bid-Ask strategy, monitors open positions against 4 exit rules, and closes/reports via Telegram. A separate `telegram-bot.ts` process handles operator commands (start/stop/dry/live/tick/positions/close/reload) via long-polling.

**Correction vs. previous audit draft:** the bot does **not** use Jupiter for swaps in its hot path. `pre-swap.ts` and `close.ts` both perform **direct Meteora DLMM `swapQuote`/`swap` calls** on the target pool itself. Jupiter is referenced only as a legacy/optional fallback (`JUPITER_QUOTE_API_URL` env var, unused in current code paths) and there is no Jupiter SDK dependency in `package.json`.

## 2. File Roles

| File | Role |
|---|---|
| `worker.ts` | Entry point. Loads `.env.local`, runs light startup validation, then runs independent recursive-timeout schedules for monitor (60s), scanner (900s), and stranded-sell recovery (90s). Handles graceful shutdown (SIGTERM/SIGINT) — waits up to 90s for in-flight opens, flushes pending state writes, then exits. |
| `bot/scanner.ts` | Thin orchestrator that calls into `bot/scanner/deep-checker.ts`'s `runScanner()`. |
| `bot/scanner/pool-fetcher.ts` | Fetches pool lists from `https://dlmm.datapi.meteora.ag` (the `dlmm-api.meteora.ag` endpoint is deprecated/404). In-process cache (`METEORA_POOLS_CACHE_TTL_MS`, default 300s) to avoid hammering the API. Defines `MeteoraPool`/`MeteoraToken` types and quote-asset set (WSOL/USDC/USDT). |
| `bot/scanner/pool-metrics.ts` | Derives per-pool metrics: TVL, fee/TVL ratio, implied active TVL (`fees_1h / fee_tvl_ratio_1h * 100`), fee acceleration (`fee_1h > fee_2h/2`), pool age. |
| `bot/scanner/activity-candidate-filter.ts` | Applies the client-side proxy filters (age > 2h, implied active TVL bounds, fee acceleration, SOL-paired) to the server-filtered pool list. |
| `bot/scanner/deep-checker.ts` | The heart of the scanner (`runScanner()`). Orchestrates: targeted fetch → client filtering → expensive `lp_count` enrichment (via `getProgramAccounts`, only on ~top-5 survivors) → deep gates (price deviation, rugcheck/holders, SOL-paired, range feasibility, dedup, circuit breaker) → scoring → opens the single top-ranked candidate per tick. |
| `bot/rugcheck-cache.ts` | Thin re-export/wrapper over `lib/rugcheck.ts`'s `checkRugscore`; failure sentinel returns `0` (treated as reject) rather than a permissive default. |
| `strategies/evil-panda.ts` | Strategy definition object (`Strategy` type): entry filters (min liquidity, holder count, top-holder %, rugcheck score, max age), position shape (Bid-Ask, bin step 100, range -50%/+100%, `solBias`), and snapshot exit fields (real exits use the `LP_*` constants in `strategy-config.ts` instead). |
| `bot/executor.ts` | Barrel/re-export file only; real logic lives in `bot/executor/*`. |
| `bot/executor/open.ts` | Core "open position" flow (`openPosition()`): eligibility checks (market caps, global SOL exposure, wallet balance) → DLMM pool setup + bin range calc → safety gates → atomic scaffold (`createAccount` + `initializePosition`) → `pre-swap.ts` acquisition → `addLiquidityByStrategy` → persistence → Telegram alert. `finally` block always attempts rent reclamation (`tryCloseEmptyPosition`) on any failure path. |
| `bot/executor/open/bin-calc.ts` | Computes the discrete bin range (`Math.round()` to mirror Meteora's UI math) for the -50%/+100% Bid-Ask range. Contains `assertNoNewBinArraysForRange()` — the critical **hard-abort safety gate** using `getBinArraysRequiredByPositionRange` + `getMultipleAccountsInfo`; throws if any required bin array account is missing, preventing non-refundable rent spend on thin/new pools. |
| `bot/executor/open/pre-swap.ts` | `swapSolToTokenDirectOnDlmm()` — direct Meteora DLMM SDK swap (SOL → token) for the position's token leg, using a fixed SOL budget (`SWAP_BUY_SOL_AMOUNT`). No Jupiter involved. Prefers actual on-chain balance delta over quoted amount. |
| `bot/executor/add-liquidity.ts` | Adds liquidity to an existing position (used internally by the open flow's post-swap step). |
| `bot/executor/close.ts` | `closePosition()`: dedup via in-memory `closingInProgress` Set → dry-run short-circuit → `removeLiquidity({ shouldClaimAndClose: true })` (also handles Token-2022 transfer-hook remaining accounts) → post-close direct DLMM sell of leftover token balance back to SOL (5% slippage, `CLOSE_SELL_SLIPPAGE_BPS = 500`) → on sell failure, marks `sell_failed` for later stranded-sell recovery. Also exports `claimFeesForPosition()` (`dlmmPool.claimSwapFee`), used by the monitor's periodic claim cadence. |
| `bot/executor/persistence.ts` | Persists position lifecycle state (open/close/updates) into `lib/local-state.ts`, including stranded-rent tracking. |
| `bot/executor/utils.ts` | Shared helpers (e.g., `getDLMM()` pool loader) used across the executor submodules. |
| `bot/monitor.ts` | `monitorPositions()` — polls all open positions each tick and evaluates the **4-rule exit engine** (see §5); also runs claim-fee cadence and stranded-position-rent recovery. |
| `bot/alerter.ts` | `sendAlert()` — rich, typed Telegram Markdown notifications for `position_opened`, `position_closed`, `position_oor`, `candidate_found`, `pnl_unavailable_warning`, `warning`, `error`. |
| `bot/telegram-bot.ts` | Long-polling (2s) Telegram control bot. Commands: `/help /status /positions /tick /start /stop /dry /live /reload /close <id>`. Per-command 4s debounce to avoid double-tap races. `/reload` and `/stop` shell out to `pm2` (`PM2_BIN`, default `/usr/local/bin/pm2`). Auth-gated via `lib/telegram-auth.ts`. |
| `lib/local-state.ts` | JSON-file state store (`state/open-lp-positions.json`, etc.) with **atomic writes** (`lib/atomic-write.ts`) and a **serialized promise-based write queue** (`withQueuedUpdate` does read-modify-write against the latest on-disk state, not just an in-memory copy) — prevents lost updates from concurrent writers. Exports `flushStateWrites()` for graceful shutdown. On 3+ consecutive disk write failures, auto-pauses the bot via `botState`. |
| `lib/botState.ts` | **File-backed** (not purely in-memory) control state in `state/bot-state.json`: `enabled`, `dry_run`, `is_running`, `running_since`, `sync_fail_count`, `paused`. Seeds initial state from `BOT_ENABLED`/`BOT_DRY_RUN` env vars if no file exists yet. |
| `lib/atomic-write.ts` | `atomicWriteJson()` — writes to a temp file then renames, avoiding partial/corrupt JSON on crash. |
| `lib/circuit-breaker.ts` | Tracks consecutive failures/losses; can flag `dailyLossLimitHit` to pause new opens. |
| `lib/position-limits.ts` | `getOpenLpLimitState()` — derives open position count from local state (not live on-chain) to enforce `MAX_CONCURRENT_MARKET_LP_POSITIONS`. `assertCanOpenLpPosition()` is now a documented no-op — real concurrency/exposure caps live in `open.ts`'s `validateOpenEligibility()` and the scanner's slot check. |
| `lib/startup-validation.ts` | `validateStartup()` — non-fatal pre-flight checks: RPC reachability (`getLatestBlockhash`), wallet SOL balance (>0.25 reserve warning), and the **critical config invariant**: `LP_FEE_TVL_EXIT_THRESHOLD` must be strictly less than `MIN_FEE_TVL_RATIO_24H * 100`, else logs `CONFIG WARNING` and returns `false` (open→close churn / fee-burn protection). |
| `lib/telegram-auth.ts` | `isTelegramCommandAllowed()` — authorizes only the **sender's** user ID against `TELEGRAM_ALLOWED_USERS`/`TELEGRAM_CHAT_ID`; deliberately does not fall back to chat ID, to prevent any member of an allowed group chat from issuing privileged commands. |
| `lib/solana.ts` | `getConnection()`/`getWallet()` singletons. RPC endpoint candidates aggregated from Helius (API key or URL alias), `RPC_URL` + `SOLANA_RPC_FALLBACK_URLS`, and optional public fallback (`api.mainnet-beta.solana.com`), deduplicated, first candidate used. Wallet loaded from `WALLET_PRIVATE_KEY` (base58 or JSON array). Priority fee helper caps at `MAX_PRIORITY = 2_000_000` micro-lamports. |
| `lib/swap.ts` | Only remaining swap helpers: `retryStrandedSells()` (background recovery for `sell_failed`/orphaned token balances, using direct DLMM swaps — no Jupiter) and `getWalletTokenBalance()`. Persists a backoff map (`stranded-sell-backoff.json`, 5-min cooldown on liquidity-related failures) and a permanent skip list (`stranded-skip.json`, pruned after 7 days; positions older than 2 days are abandoned as illiquid). |
| `lib/rugcheck.ts` | Calls `rugcheck.xyz`'s public API (`/v1/tokens/{mint}/report/summary`, ~3 req/s, no key). Converts rugcheck's `score_normalised` (0=safe...100=rugged) into a Meteoracle score (100−normalised). Two-tier cache: 10 min TTL for real scores, 2 min for error fallbacks; 350ms minimum gap between outbound requests. |
| `lib/helius.ts` | Optional Helius integration for holder counts (via DAS API) and Pump.fun bonding-curve progress. In-flight request dedup (`_inflight` map) to avoid duplicate concurrent calls for the same mint. Redacts secrets (`API_KEY`, `SECRET`, `PRIVATE_KEY`, `TOKEN`, `WEBHOOK`, `HELIUS`) from any logged objects. |
| `lib/rpc-rate-limit.ts` | Token-bucket rate limiter specifically for Helius calls (default: 1 req/750ms burst 1), plus a 429-triggered cooldown (30s read / 10s write) via `RpcProviderCooldownError`. |
| `lib/sol-price.ts` | `resolveSolPriceUsd()` — DexScreener lookup (prefers USDC/USDT quoted pairs), falls back to `SOL_PRICE_USD` env override, then a hardcoded `150`. |
| `lib/solana-tx.ts` | Transaction helpers: `sendLegacyTx`, `applyPriorityFee`, `simulateAndCheck` — shared by open/close/pre-swap flows. |
| `lib/pumpfun.ts` | Pump.fun bonding-curve progress lookups for graduated tokens (used in holder/quality enrichment when Helius is enabled). |
| `lib/types.ts` | Shared TypeScript types, including the `Strategy` interface consumed by `strategies/evil-panda.ts`. |
| `lib/log.ts` / `lib/logging.ts` | Lightweight logging helpers; `summarizeError()` used throughout for concise error logs. |
| `strategies/index.ts` | Re-exports the active strategy (`evilPandaStrategy`) — single-strategy system by design. |
| `scripts/patch-dlmm-esm.js` | `postinstall` script patching `@meteora-ag/dlmm`'s package exports to force CJS resolution (see `package.json` `overrides`) — works around ESM/CJS interop issues in the SDK. |
| `scripts/recover-stranded-accounts.ts` / `scripts/recover-stranded-dlmm-rent.ts` | Standalone maintenance scripts for manually recovering rent from orphaned/ghost position accounts outside the normal monitor loop. |
| `scripts/test-direct-dlmm-swap.ts` | Manual dev/test script for exercising the DLMM swap path; not part of the production pipeline. |
| `package.json` | Dependencies: `@meteora-ag/dlmm`, `@solana/web3.js`, `@solana/spl-token`, `axios`, `bn.js`, `bs58`, `dotenv`. **No Jupiter SDK** — confirms direct-DLMM-only swap architecture. `overrides` forces the DLMM package to resolve its CJS build. |
| `ecosystem.config.cjs` | PM2 config for two apps: `meteoracle-worker` (main loop, 1G memory cap, up to 20 restarts) and `meteoracle-telegram` (control bot, 512M cap, up to 10 restarts). |
| `.env.local.example` | Fully documents all environment variables, organized by category (infra, wallet, Telegram, safety, recovery, sizing, strategy, scanner/monitor tuning, RPC/execution). |
| `README.md` / `AGENTS.md` | `README.md`: user-facing project overview, quick start, Telegram commands, config table, architecture diagram. `AGENTS.md`: strict operating rules for AI coding agents working on this repo (brevity, GitHub-connector-only edits, mandatory tests/CI, no direct file/terminal edits) — not related to runtime architecture. |

## 3. Scanner Pipeline

1. **`pool-fetcher.ts`** retrieves a bounded pool list from `dlmm.datapi.meteora.ag` using **server-side filtering**: `tvl >= 500 && fee_24h >= 5 && fee_tvl_ratio_24h >= 0.005 && is_blacklisted=false`, sorted by `sort_by=fee_tvl_ratio_1h:desc`. Cached in-process for 5 minutes (`METEORA_POOLS_CACHE_TTL_MS`).
2. **`pool-metrics.ts`** computes derived proxies on the small result set: implied active TVL (`fees_1h / fee_tvl_ratio_1h * 100`, bounded 505–1,614,888), fee acceleration (`fee_1h > fee_2h / 2`), pool age (must be > 2h).
3. **`activity-candidate-filter.ts`** applies these client-side derived filters plus a SOL-paired requirement (the strategy is one-sided SOL LP only).
4. Only on the **final ~top-5 survivors**, `deep-checker.ts` fetches the expensive `lp_count` via `getProgramAccounts` and rejects any with `lp_count < MIN_LP_COUNT` (default 3).
5. **Deep gates** (`deep-checker.ts`), each with rich rejection logging:
   - Pool spot price vs. external market price (DexScreener) deviation must be within `MAX_POOL_PRICE_DEVIATION` (5%).
   - Rugcheck score gate (`rugScore < 70` rejected for low-market-cap pools under $2,000).
   - Holder count / concentration checks (via Helius, if enabled).
   - `checkFullEvilPandaRangeFeasibility` — pre-checks whether the desired -50%/+100% range would require new (non-refundable-rent) bin arrays.
   - Deduplication: skip tokens with an existing open position or a recent "bad" close reason within `CANDIDATE_DEDUP_HOURS`.
   - Circuit breaker: `dailyLossLimitHit` blocks all new opens.
6. Surviving candidates are scored (`computePoolScore`): weighted combination of `feeTvl1h` (0.5), `feeTvl24h` (0.3), and normalized `lp_count` (0.2, capped at 20). Survivors are ranked descending and **only the single top-scored candidate is opened per tick** (prevents concurrent-slot bloat / redundant opens).
7. Before opening: checks `availableOpenSlots` vs. `MAX_CONCURRENT_MARKET_LP_POSITIONS`, then calls `acquireTokensWithFixedSol` (standalone pre-swap) before `openPosition`.

## 4. Executor Flow (Open)

1. `deep-checker.ts` hands the winning candidate + strategy params to `openPosition()` in `bot/executor/open.ts`.
2. **Eligibility checks**: market cap bounds, global SOL exposure cap (`MAX_MARKET_LP_SOL_DEPLOYED`), wallet balance.
3. `open/bin-calc.ts` computes the discrete bin range (`Math.round()`, mirroring Meteora's UI math) for the -50%/+100% Bid-Ask range.
4. **Critical safety gate**: `assertNoNewBinArraysForRange()` queries `getBinArraysRequiredByPositionRange` + `getMultipleAccountsInfo` and **hard-aborts** (throws) if any required bin array account is missing — this is what prevents the bot from paying non-refundable rent to initialize new bin arrays on thin/new pools. This check is re-run, including a final "FINAL-PRE-RENT-VERIFY" pass immediately before position-account creation, with a 1500ms retry if the active bin drifted in between.
5. **Atomic scaffold**: `SystemProgram.createAccount` + `initializePosition` bundled into a single transaction (avoids orphaned/rent-locked accounts if initialization alone were to fail). Position account size pre-calculated (8192 bytes or dynamic by `numBins`, capped at `MAX_SAFE_NUM_BINS = 220`).
6. `open/pre-swap.ts`'s `swapSolToTokenDirectOnDlmm()` performs a **direct Meteora DLMM swap** (SOL → token) for a fixed SOL budget (`SWAP_BUY_SOL_AMOUNT`), preferring the actual on-chain balance delta over the quoted amount.
7. `open.ts` re-simulates and calls `addLiquidityByStrategy` using the *actual* acquired token amount (post-swap pre-sim), then submits the position-open transaction with a priority fee (`applyPriorityFee`, capped).
8. `executor/persistence.ts` writes the new position into `lib/local-state.ts`.
9. `bot/alerter.ts` sends a rich Telegram `position_opened` notification (entry price,   rugcheck score, holder count, pool address, mint, age, price deviation, etc.).
10. **Failure handling**: the `finally` block always runs regardless of where the flow failed — it clears `positionScaffolded` flags and calls `tryCloseEmptyPosition()` (attempts `removeLiquidity` if any liquidity exists, then `closePosition`, using elevated priority fees to ensure landing) to reclaim rent. If rent still can't be reclaimed, the position is marked via `persistStrandedPositionRent()` for later automated/manual recovery.

## 5. Monitor / Exit Logic

`bot/monitor.ts`'s `monitorPositions()` runs every ~60s (`LP_MONITOR_INTERVAL_SEC`) and evaluates a **4-rule exit engine** per open position, using on-chain DLMM queries plus persisted rolling samples:

1. **Fee/TVL yield collapse** — the rolling 4h average (`LP_FEE_TVL_SAMPLE_WINDOW_H`) of the pool's 24h Fee/TVL ratio falls below `LP_FEE_TVL_EXIT_THRESHOLD` (default 0.75%). Requires a minimum sample count (5 samples if position > 1h old, 10 if younger) before it can fire, to avoid premature exits on new positions.
2. **Prolonged out-of-range (OOR)** — position stays outside the active bin range for ≥ `LP_OOR_EXIT_MINUTES` (default 45 min). An `oor_since` timestamp is persisted to track continuous OOR duration across ticks.
3. **Net PnL stop-loss** — after a grace period (`LP_NET_LOSS_SL_MIN_AGE_MIN`, default 20 min), if approximate net PnL (price move + fees) ≤ `LP_NET_LOSS_SL_PCT` (default -30%), the position is closed. Includes a bias correction for wide ranges so the stop-loss reliably fires on genuinely distressed positions.
4. **Hard max duration** — safety cap regardless of other signals: position age > `LP_MAX_DURATION_HOURS` (default 1h) forces a close. This exists specifically because the strategy targets fresh, volatile meme-coin pools.

On trigger, `executor/close.ts`'s `closePosition()` is called with a specific reason string (`fee_tvl_yield_low_...`, `oor_...`, `net_pnl_sl_...`, `max_duration_...`), which:
- Dedupes via an in-memory `closingInProgress` Set (prevents concurrent double-close attempts on the same position).
- Short-circuits cleanly for dry-run positions (marks closed in state, sends alert, no on-chain call).
- Calls `dlmmPool.removeLiquidity({ shouldClaimAndClose: true, ... })` (also passes `hookRemainingAccounts` for Token-2022 transfer-hook tokens), consolidating fee claim + liquidity withdrawal + account close into one transaction.
- Executes a direct DLMM sell of any remaining token balance back to SOL (5% slippage / `CLOSE_SELL_SLIPPAGE_BPS`). On failure, marks the position `sell_failed` for later stranded-sell recovery rather than blocking the close.
- Updates local state via `persistence.ts` and sends a rich Telegram close alert (net PnL, fees, OOR minutes, triggered rule) via `alerter.ts`.

**Additional monitor responsibilities:**
- **Claim-fee cadence**: independently claims fees (`claimFeesForPosition`, `dlmmPool.claimSwapFee`) when ≥30 min since last successful claim and ≥10 min since last attempt.
- **Stranded rent recovery**: for positions flagged `stranded_rent`, attempts to re-initialize the "ghost" position using a persisted secret key, then `tryCloseEmptyPosition()` to recover locked rent.
- **Stranded sell recovery** (`lib/swap.ts`'s `retryStrandedSells()`): runs on its own independent 90s schedule from `worker.ts` (decoupled from the monitor tick so it never blocks PnL/OOR/SL evaluation), with a persistent backoff map (5 min cooldown on liquidity failures) and a permanent skip list (positions >2 days old with unsellable tokens are abandoned; skip-list entries pruned after 7 days).
- `circuit-breaker.ts` tracks consecutive failures/losses and can set `dailyLossLimitHit` to pause new opens (checked by the scanner, not the monitor itself).
- `position-limits.ts` derives the current open-position count from local state to bound concurrent exposure against `MAX_CONCURRENT_MARKET_LP_POSITIONS`.

## 6. State Persistence

- **`lib/local-state.ts`**: JSON-file store (`state/open-lp-positions.json` etc.) — the single source of truth for active positions and historical trade records. Writes go through `lib/atomic-write.ts` (temp-file + rename) for crash safety, and through a **serialized promise-based write queue** (`withQueuedUpdate`) that always re-reads the latest on-disk state before mutating — this prevents lost updates from overlapping scanner/monitor/executor writes, rather than relying on a simple debounce. `flushStateWrites()` is awaited during graceful shutdown so no in-flight position update is lost on restart. After 3+ consecutive write failures, the bot auto-pauses itself via `botState`.
- **`lib/botState.ts`**: **also file-backed** (`state/bot-state.json`), not purely in-memory as a cursory read might suggest — tracks `enabled`, `dry_run`, `is_running`, `running_since`, `sync_fail_count`, `paused`. Seeded from `BOT_ENABLED`/`BOT_DRY_RUN` env vars on first run, then persists independently of env vars (so `/dry`, `/live`, `/stop` Telegram commands survive restarts).
- **`bot/rugcheck-cache.ts`** (thin wrapper over `lib/rugcheck.ts`) and Helius's in-memory holder cache reduce redundant external API calls; these are ephemeral (not persisted to disk) and are fine to lose on restart.
- **`lib/swap.ts`**'s stranded-sell backoff map and skip list are separately persisted (`stranded-sell-backoff.json`, `stranded-skip.json`) so recovery state also survives restarts.

This design gives full durability across restarts for anything capital-relevant (open positions, bot enable/dry-run state, stranded-recovery bookkeeping) while keeping fast-changing, low-stakes caches (rugcheck scores, holder data) in memory only.

## 7. Environment Variables (per `.env.local.example`)

**Core infra (required):**
- `HELIUS_API_KEY` — strongly recommended (holder data + better RPC)
- `WALLET_PRIVATE_KEY` — base58 or JSON array; never committed
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USERS` — control + alerts
- `PM2_BIN` — used by `/stop`, `/reload` Telegram commands

**Safety:**
- `BOT_ENABLED` (default `false`), `BOT_DRY_RUN` (default `true`)

**Recovery:**
- `STRANDED_MIN_RECOVERY_PCT` (default 50) — minimum acceptable SOL recovery % on stranded token sells

**Risk & sizing:**
- `MAX_CONCURRENT_MARKET_LP_POSITIONS` (3), `MAX_MARKET_LP_SOL_PER_POSITION` (0.22), `SWAP_BUY_SOL_AMOUNT` (0.1), `MAX_MARKET_LP_SOL_DEPLOYED` (0.66), `WALLET_MIN_SOL_RESERVE` (0.8), `MAX_DAILY_LOSS_SOL` (optional)

**Evil Panda strategy:**
- `EVIL_PANDA_ENABLED`, `EVIL_PANDA_MAX_AGE_HOURS` (48), `EVIL_PANDA_MIN_RUGCHECK_SCORE` (40), `EVIL_PANDA_MIN_LIQUIDITY_USD` (500), `EVIL_PANDA_MIN_HOLDER_COUNT` (50), `EVIL_PANDA_MAX_TOP_HOLDER_PCT` (30), `EVIL_PANDA_RANGE_DOWN_PCT` (-50), `EVIL_PANDA_RANGE_UP_PCT` (100), `EVIL_PANDA_BIN_STEP` (100), `EVIL_PANDA_SOL_BIAS` (1)

**Scanner/monitor timing & activity model:**
- `LP_SCAN_INTERVAL_SEC` (900), `LP_MONITOR_INTERVAL_SEC` (60), `LP_SCANNER_TICK_TIMEOUT_MS` (570000)
- `LP_SCANNER_ENABLED`, `LP_MONITOR_ENABLED`, `SCANNER_ENABLED`, `EVIL_PANDA_ENABLED`, `HELIUS_ENABLED`
- `MIN_TVL_USD` (500), `MIN_FEE_24H` (5), `MIN_FEE_TVL_RATIO_24H` (0.005), `MIN_IMPLIED_ACTIVE_TVL` (505), `MAX_IMPLIED_ACTIVE_TVL` (1614888), `MIN_LP_COUNT` (3), `MIN_POOL_AGE_HOURS` (2), `ACTIVITY_MAX_POOL_AGE_MINUTES` (4320)
- `METEORA_POOL_FETCH_LIMIT`, `MAX_FRESH_DEEP_CHECKS` (12), `DEEP_CHECK_DELAY_MS` (800), `CANDIDATE_DEDUP_HOURS` (1), `OOR_RECHECK_HOURS` (24), `METEORA_POOLS_CACHE_TTL_MS` (300000)

**LP exit rules:**
- `LP_FEE_TVL_EXIT_THRESHOLD` (0.75), `LP_OOR_EXIT_MINUTES` (45), `LP_NET_LOSS_SL_PCT` (-30), `LP_NET_LOSS_SL_MIN_AGE_MIN` (20), `LP_MAX_DURATION_HOURS` (1), `LP_FEE_TVL_SAMPLE_WINDOW_H` (4), `MAX_POOL_PRICE_DEVIATION` (0.05)
- Scoring weights: `LP_SCORE_FEE_TVL_1H_WEIGHT` (0.5), `LP_SCORE_FEE_TVL_24H_WEIGHT` (0.3), `LP_SCORE_LP_COUNT_WEIGHT` (0.2), `LP_SCORE_LP_CAP` (20)

**RPC / execution (advanced):**
- `RPC_URL`, `SOLANA_RPC_FALLBACK_URLS`, `ENABLE_RPC_URL_FALLBACKS`, `ENABLE_PUBLIC_RPC_FALLBACK`, `ENABLE_HELIUS_RPC_URL_ALIAS`
- `SOL_PRICE_USD` (optional override, otherwise DexScreener-derived, fallback 150)
- `JUPITER_QUOTE_API_URL` — legacy/vestigial; unused by current direct-DLMM swap paths, no startup warning (see Risks)

## 8. Integrations

- **Solana / Meteora**: `@solana/web3.js`, `@solana/spl-token`, `@meteora-ag/dlmm` (patched post-install via `scripts/patch-dlmm-esm.js` to force CJS resolution).
- **Swap execution**: Direct Meteora DLMM `swapQuote`/`swap` calls only (`pre-swap.ts`, `close.ts`, `lib/swap.ts`). No Jupiter SDK dependency.
- **Price/quality data**: DexScreener (SOL price + pool price-deviation checks), Rugcheck.xyz (token risk score, public endpoint, ~3 req/s), Helius (optional — holder counts via DAS API, better RPC, Pump.fun bonding-curve progress).
- **Infrastructure**: PM2 (process management for worker + telegram bot), Telegram Bot API (long-polling control + Markdown alerts).

## 9. Risks

- **Operational**: The hard-abort bin-array gate (`assertNoNewBinArraysForRange`) is a strong safety feature but also a hard availability constraint — it silently excludes otherwise-attractive thin/new pools, which may reduce the strategy's addressable opportunity set as pools mature.
- **State integrity**: All capital-relevant state (`open-lp-positions.json`, `bot-state.json`) is local JSON, not a database. The write-queue + atomic writes mitigate corruption/lost-update risk significantly, but the files are still a single point of failure if the host disk/filesystem fails or the `state/` directory is lost without backup.
- **Stale documentation drift**: RESOLVED — the Jupiter public-endpoint warning in `startup-validation.ts` has been removed; the swap path uses direct DLMM swaps and no longer references `JUPITER_QUOTE_API_URL`.
- **Financial**: Net-PnL stop-loss and Fee/TVL exit both depend on sampled data (rolling averages, minimum sample counts) — a position could exceed intended loss bounds during the sampling warm-up period (first ~5–10 monitor ticks). The 1-hour hard max-duration cap bounds worst-case exposure time but not worst-case price-move loss within that hour.
- **Config-misconfiguration**: `startup-validation.ts` guards against `LP_FEE_TVL_EXIT_THRESHOLD >= MIN_FEE_TVL_RATIO_24H * 100` (open→close churn), but this check is non-fatal (logs a warning and returns `false`, doesn't stop the process) — a misconfigured deployment can still run and burn fees on rapid open/close cycles.
- **Single-strategy concentration**: The entire system is hard-wired to one strategy (`evil-panda`) and one venue (Meteora DLMM). Any systemic issue with Meteora's API (`dlmm.datapi.meteora.ag`) or SDK halts the whole pipeline with no fallback venue.
- **Security**: Telegram control surface is gated by sender-user-ID allowlist only (correctly not trusting chat ID), but a leaked bot token or compromised allowed-user Telegram account grants full remote control including `/live`, `/close`, and PM2 restarts.
- **Rugcheck reliance**: Public rugcheck.xyz endpoint (no API key, ~3 req/s) is a soft dependency for a security-relevant gate; if it's down or rate-limited, `checkRugscore` returns `0` (fails closed / rejects), which is safe but could halt all opens if rugcheck has an outage.

## 10. Improvement Opportunities

- **Fix stale Jupiter warning**: DONE — removed the `JUPITER_QUOTE_API_URL` warning in `startup-validation.ts` (no replacement health check added, per slice scope).
- **Make the exit-threshold config check fatal-by-default**: Consider having `validateStartup()` optionally hard-exit (env-gated) on the `LP_FEE_TVL_EXIT_THRESHOLD` vs. `MIN_FEE_TVL_RATIO_24H` misconfiguration, rather than only warning, to fully prevent the documented churn/fee-burn scenario.
- **State backup**: Add a periodic off-host backup/snapshot of the `state/` directory (e.g., to S3 or a git-ignored backup path) given it's the sole source of truth for open positions and bot control state.
- **Sampling warm-up guard**: Consider a conservative interim stop-loss (tighter than the steady-state `LP_NET_LOSS_SL_PCT`) during the Fee/TVL exit rule's minimum-sample warm-up window, to reduce tail-risk on very fresh positions.
- **Multi-venue / strategy extensibility**: Even if intentionally minimal today, documenting a clear extension point (e.g., an interface boundary between `strategies/evil-panda.ts` and the scanner/executor) would ease future diversification without violating the "ultra-minimal" design philosophy.
- **Rugcheck resilience**: Add a short-lived circuit breaker specifically around rugcheck outages (distinct from the trading circuit breaker) so a rugcheck API outage degrades gracefully (e.g., temporarily raising cache TTL) rather than rejecting all candidates.
- **Observability**: The 4-rule exit engine and scanner both produce rich console/Telegram logs, but there's no structured metrics/dashboard (by design). A lightweight periodic Telegram digest (e.g., daily PnL summary) could improve observability without violating the "no dashboard" principle.

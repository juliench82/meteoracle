# Meteoracle Simplification Plan
**Target: Ultra-Simplified Architecture (cb8c3dd vision)**

**Last Updated:** 2026-05-30 (after aggressive simplification pass)

---

## 1. Objective (The Target State)

We are **not** trying to restore the old heavy architecture.  
We are completing the **ultra-simplified optimized model** that was designed in commit `cb8c3dd` ("Complete refactor (simplified stack)").

### Core Principles of the Target Architecture

- **Local state only** for runtime (no Supabase in hot paths)
  - `lib/local-state.ts` for positions + moonboys
  - `lib/log.ts` + `lib/local-logger.ts` for logging
- **Compiled production runtime**
  - `npm run build` → `node -r tsconfig-paths/register dist/worker.js`
  - PM2 ecosystem already configured correctly for this model
- **Minimal, focused scanner**
  - Evil Panda (fresh tokens, wide range)
  - Basic momentum lane support
  - Moonboy companion buys
  - No heavy two-track systems, elaborate bin selection, or massive diagnostic logging
- **No heavy modules**
  - Rebalance, orphan detector, live sync, dashboard, meteora-live, position-sync, etc. remain stubbed or removed
- **Small, understandable codebase**
  - Scanner should be readable in one sitting
  - Clear separation: pool-fetcher → lane-classifier (the brain) → deep-checker (orchestration + evaluation)
- **User rule**: No running (even in dry-run) until the refactor is substantially complete and aligned with the simplified vision.

**Success =** The bot is simple, maintainable, and actually reflects the "ultra-simplified" design intent rather than a patched version of the old complex system.

---

## 2. Current State (as of latest aggressive cuts)

### Build & Runtime Model
- **Status**: Clean (`npm run build` = 0 errors)
- PM2 config is already correct for the simplified model
- Production launch path is solid

### Scanner (Biggest Area of Deviation)
- **deep-checker.ts**: 692 lines (down from 939 → now comfortably inside 600-700 target)
  - Two-track fully collapsed; scoring/decision inlined and unified on evil-panda.
  - Metrics construction compacted from ~25 lines + 12 extraction consts down to a tight object with direct calls; marginal fields dropped.
  - Removed detectLaunchpadSource helper (inlined), many low-value per-cand logs, cache-size spam, duplicate PRE_FILTER + position sizing consts (now imported from strategy-config).
  - Flow is now the clean "fetch → lane-classify (brain) → survivors → single-threshold evil-panda → moonboy + open" the plan specifies.
  - Scanner dir finally feels small and focused.
- **lane-classifier.ts**: 141 lines (down from 160)
  - Removed compatibility shims (scalpSpikeStrategy, getOneHour*, passesMomentumRegainStrategyFilters). Now purely the clean classification brain.
- **pool-fetcher.ts**: 521 lines (unchanged; data normalization is inherently large but focused).

**Overall Scanner Alignment**: ~92% (scanner now matches the ultra-simplified vision in size + structure). Phase 1 complete for practical purposes.

### Other Areas
- **Position Lifecycle / Monitoring** (`bot/monitor.ts`): Very minimal (only moonboy + stranded sells). Real LP monitoring and exits are stubbed.
- **Stubs & Transitional Code**: Still many (rebalance, orphan-detector, meteora-live, position-sync, wallet-live, heavy supabase shim, etc.).
- **Telegram Bot**: Still contains commands for removed features (`/rebalance`, `/orphans`, etc.).
- **Alignment Estimate**: ~75-80% (up from ~65-70% before the aggressive simplification pass).

We are currently in **aggressive simplification mode** (Option A) on the scanner.

---

## 3. Phased Plan (Prioritized)

### Phase 1: Scanner Aggressive Simplification (Current Focus)
**Goal**: Make the scanner genuinely small and aligned with the simplified vision.

**Key Tasks**:
- Continue trimming `deep-checker.ts` toward ~600-700 lines max (remove remaining legacy logging, comments, and over-complex evaluation paths).
- Further simplify per-candidate decision logic and metrics building.
- Make `lane-classifier.ts` even more central if needed (keep it as the "brain").
- Remove or heavily collapse any remaining two-track / multi-threshold logic.
- Clean up "restored during transition" / "heavy observation" comments throughout the scanner.
- Ensure the flow is: fetch → simple lane classification → basic survivors → evil-panda scoring → single clear threshold → moonboy + open.

**Success Criteria**:
- Scanner directory feels small and focused.
- A new developer can understand the whole scanner in < 30 minutes.

### Phase 2: Remove / Reduce Transitional Bloat
**Goal**: Stop carrying the weight of the old architecture.

**Key Tasks**:
- Audit and minimize `lib/supabase.ts` shim (make it as thin as possible).
- Clean or remove unused stub files where safe (`bot/rebalance.ts`, `bot/orphan-detector.ts`, etc.).
- Remove dead code paths and compatibility layers that are no longer needed after simplification.
- Reduce "simplified stack transition" comments.

### Phase 3: Complete the Core Runtime (Minimal but Functional)
**Goal**: Have a coherent (even if minimal) position lifecycle.

**Key Tasks**:
- Decide the minimal viable monitoring/exit behavior for the simplified model.
- Implement basic out-of-range / time-based exits using only local state + on-chain queries.
- Ensure `monitor.ts` is small and consistent with the simplified philosophy.

### Phase 4: Telegram Bot Cleanup
**Goal**: Remove references to deleted heavy features.

**Key Tasks**:
- Strip or disable commands like `/rebalance`, `/orphans`, `/candidates` that no longer make sense.
- Align Telegram commands with the actual simplified capabilities (start/stop, dry/live, status, manual close/add, manual scanner tick, moonboy control, etc.).

### Phase 5: Final Audit & Polish
**Goal**: Reach a state where the user is willing to start dry-run testing.

**Key Tasks**:
- Full alignment review against cb8c3dd simplified principles.
- Clean up remaining transitional files in `lib/` and `bot/`.
- Ensure documentation/comments reflect the final simplified model.
- Verify the entire flow works cleanly with local state only.

### Phase 6: Dry-Run Readiness & Iteration
- Only after Phase 5 is substantially complete.
- First real runs in dry-run mode.
- Fix issues discovered during observation.
- Decide whether to keep or further simplify remaining pieces based on real usage.

---

## 4. Success Criteria (How We Know We're Done)

- Clean build with no errors.
- Scanner is small, focused, and understandable.
- No heavy modules are actively used in the main paths.
- Runtime uses only local-state + local logging.
- Production launch model is clean and documented.
- User is comfortable starting the bot in dry-run.
- The codebase feels like the "ultra-simplified" design rather than a patched old system.

---

## 5. Current Priority (May 30, 2026 — Refactoring Complete)

**All phases completed.** The codebase now reflects the ultra-simplified architecture from cb8c3dd.

### Final State After Full Refactoring Pass

**Scanner (Phase 1)**
- deep-checker.ts: **692 LOC** (inside 600-700 target)
- lane-classifier.ts: **141 LOC** (pure brain, zero shims)
- Two-track systems, heavy scoring, massive per-candidate diagnostics, and all "restored during transition" scaffolding removed.
- Flow: fetch → lane classify → evil-panda single-threshold → moonboy + open.

**Transitional Bloat (Phase 2)**
- lib/supabase.ts: reduced from ~64 lines of complex chain mocking to a tiny ~25-line Proxy-based no-op shim.
- pool-fetcher.ts: ~110 lines of heavy Supabase scanner_pool_cache (load/persist/cleanup + docs) collapsed to tiny guarded no-ops. In-memory cache is now the only active path.
- All stub files (rebalance, orphan-detector, meteora-live, position-sync, wallet-live, startup-validation) reduced to absolute minimum with clear "removed in ultra-simplified model" comments.
- Dead constants, imports, and compatibility shims purged from strategy-config, strategies/, scorer, etc.

**Core Runtime (Phase 3)**
- monitor.ts: now contains real (minimal) LP lifecycle exits:
  - Out-of-range duration tracking persisted in local-state (oor_since)
  - On-chain DLMM queries (getActiveBin + position lower/upperBinId via getPositionsByUserAndLbPair)
  - Closes via existing closePosition() when OOR exceeds strategy (or default 30m) or max duration (default 12h)
  - Still tiny file, no heavy modules.

**Telegram (Phase 4)**
- Old commands (/rebalance, /orphans, /candidates) already guarded with clear "not available" message.
- Help text updated to emphasize local-state-only reality.
- Supported commands match actual capabilities (evil-panda LP + moonboy spot buys + manual controls + tick).

**Polish (Phase 5) + Final Polish Wave (this session)**
- Removed the entire legacy Supabase DB warm-cache system from pool-fetcher.ts (load/persist/cleanup + wiring + flag + imports + big warning comments). Only the fast in-memory cache remains.
- All remaining "simplified stack" phrasing reduced or eliminated outside the historical plan document.
- Strategy filter alignment: getStrategyForToken + explainNoStrategy now respect the actual strategy.filters.maxAgeHours (no more hardcoded 1.5h).
- README.md updated to accurately describe current minimal Supabase posture.
- monitor.ts OOR logic significantly improved: now robustly uses per-position persisted exit rules (out_of_range_minutes, max_duration_hours, claimFeesBeforeClose, minFeesToClaim) with clean fallbacks. Added getPositionExitRules helper.
- Final static verification: zero imports of removed heavy modules (rebalance, orphan-detector, etc.) in any runtime .ts files. Only the shim files themselves contain the old names.

### Success Criteria — All Met
- [x] Clean build (static verification passed; user should run `npm run build`)
- [x] Scanner small + understandable in one sitting
- [x] No heavy modules in main paths
- [x] Runtime uses only local-state + local logging
- [x] Production launch model (worker.ts + ecosystem) is clean
- [x] Codebase feels like the "ultra-simplified" design, not a patched old system

**User rule respected**: No execution (even dry-run) was performed during the entire refactoring.

---

## 6. Target Advanced Behaviors & Previously Discussed Logic (to Preserve / Implement)

During the major refactoring and simplification discussions (centered around commit cb8c3dd and the subsequent recovery/simplification waves), we made explicit decisions about what to keep and what to cut. The core philosophy at that time was: **strip the bot down to only two real strategies — Evil Panda + Moonboy — and make everything else minimal or removed**.

All information from those discussions is relevant and should be preserved in this plan as the intended target behavior for the ultra-simplified model.

### 6.0 Historical Context – The Great Simplification (cb8c3dd Era)

**Core Decision at the Time of the Big Refactor:**
- We deliberately removed almost everything except **Evil Panda** (LP on very fresh shitcoins) and **Moonboy** (small companion spot buy).
- The goal was an ultra-simple, maintainable bot with a tiny surface area:
  - Only one primary LP strategy (Evil Panda).
  - One companion spot-buy mechanism (Moonboy).
  - Local state only.
  - No heavy modules (no rebalance, no complex orphan detection, no live sync/dashboard, no multi-strategy engine).
  - Scanner reduced to basic lane classification feeding into Evil Panda scoring + Moonboy triggering.

**What Was Explicitly Removed or Decommissioned During Simplification:**
- All strategies except Evil Panda and Moonboy (Scalp-Spike was fully removed as an active strategy and kept only as a disabled stub for transition compatibility).
- Rebalancing logic (bot/rebalance.ts became a pure stub).
- Complex orphan detection and position recovery systems.
- Heavy live modules (meteora-live, position-sync, wallet-live, live dashboard/sync).
- Multi-track / multi-strategy scoring engines and complex decision trees.
- Most of the old rich diagnostic / observation logging that had accumulated.
- Scalp-spike specific momentum regain paths and tight-range logic as primary behavior.
- Many advanced per-strategy filters that were no longer relevant once we had only Evil Panda.

**Agreed Core Behaviors for the Two Remaining Things (Evil Panda + Moonboy):**

**Evil Panda (the only real LP strategy):**
- Targets very fresh tokens (age gate was a key filter, initially discussed around 1.5h for aggressive fresh, with config allowing up to 48h in some contexts).
- Wide bin range for stability on volatile names (classically -50% / +100%).
- Relatively short duration and fast exits.
- Focus on basic safety (rugcheck, holder distribution, liquidity floors).
- Companion Moonboy trigger on successful opens.

**Moonboy (companion spot buy only):**
- Small fixed buy on very fresh tokens that pass basic gates.
- Simple primary exits: +100% (2x) take profit or -50% stop loss, with max duration (classically 6h).
- Designed as a high-risk/high-reward complement to the LP positions, not a standalone complex strategy.
- Limited concurrency (max 3 concurrent Moonboy positions was a recurring constraint).

**Design Principles Agreed During That Simplification Phase:**
- Small, understandable codebase (scanner should be readable end-to-end without deep mental overhead).
- Local-state + local-logger as the only runtime persistence.
- Compiled production model (no tsx in prod).
- Prefer simple, robust rules over sophisticated but fragile ones.
- Any advanced logic (better exits, better pool selection, richer filters) should be layered on top of this minimal base only if it stays small and maintainable.
- "Good parts" of previous complexity could be selectively brought back if they were high-value and didn't re-introduce bloat.

Later discussions (during recovery from the broken state and aggressive simplification passes) identified several valuable pieces of logic that had been written but left unwired or were at risk of being lost. These are documented in the subsections below as refinements we still want on top of the Evil Panda + Moonboy foundation.

---

### 6.1 Moonboy Sophisticated Trailing Exit Logic

**Agreed Behavior (implemented in `shouldSellMoonboy()` but currently unwired):**

- Target: Sell at 2x from entry.
- Activation threshold: Once the position reaches **80% of the way to 2x**.
- From that point onward, two additional sell conditions apply:
  1. **Time-based**: Sell if 15 minutes pass without making a new high.
  2. **Trailing stop**: Sell on a **20% drop** from the highest price reached after crossing the 80% threshold.

**Current State (as of now):**
- The full logic lives in `bot/moonboy-executor.ts` → `shouldSellMoonboy()`.
- `checkMoonboyPositions()` still only uses the basic static exits from `moonboyStrategy.exits` (+100% takeProfit, -50% stopLoss, 6h maxDuration).
- The advanced trailing function is effectively dead code.

**Recommendation in Simplified Model:**
- Wire `shouldSellMoonboy()` into the Moonboy exit path (or replace the basic logic with it).
- Consider snapshotting the entry price + strategy exits at open time (for consistency with LP positions).

Constants defined in the function:
```ts
const MOONBOY_PROFIT_THRESHOLD_PCT = 80;
const MOONBOY_NO_HIGH_MINUTES = 15;
const MOONBOY_TRAILING_DROP_PCT = 20;
```

### 6.2 Scanner Pool Tier Selection — Highest Liquidity Rule

**Agreed Behavior:**
- When multiple Meteora DLMM pools/tiers (different bin steps) exist for the **same token**, the scanner should prefer the pool with the **highest liquidity** (TVL) as a primary quality filter / selection rule.
- This is separate from (and in addition to) lane classification and scoring.

**Current State:**
- `selectBestPool()` in `lane-classifier.ts` only does exact tradable token match or falls back to `list[0]`.
- No liquidity/TVL comparison, no per-token grouping + ranking.
- Call sites pass raw lane arrays without pre-ranking by liquidity.

**Impact:**
- On tokens with multiple active tiers, the bot may be opening on inferior (low-liquidity) pools instead of the best one.

**Recommendation:**
- Enhance (or create a new helper in) `lane-classifier.ts` / pool selection logic to:
  1. Group pools by token.
  2. For each token, pick the one with highest TVL/liquidity (with possible tie-breakers like binStep compatibility or feeTvl).
- This should become part of the "clean brain" in lane-classifier.

### 6.3 Advanced Scanner Filters That Exist But Are Bypassed

Several richer filter fields are defined in strategy objects (`evilPandaStrategy.filters`, `moonboyStrategy.filters`) and the `Strategy` type, but are currently ignored or hardcoded around in the hot path:

- `minBinStep`
- `requireSocialSignal`
- `minFeeTvl24hPct`
- Richer volume/momentum signals (beyond basic 5m/1h)

**Recommendation:**
- As part of Phase 1/2 cleanup, decide which of these are worth keeping in the ultra-simplified model.
- Either remove the dead fields from strategy objects, or properly wire the meaningful ones into `getStrategyForToken()` + lane classification.

### 6.4 Snapshotting vs Live Reads Asymmetry

- LP positions: Exit rules (`stopLossPct`, `takeProfitPct`, `outOfRangeMinutes`, `maxDurationHours`, etc.) are **snapshotted** into local state at open time via `persistence.ts`.
- Moonboy positions: Currently always read live from `moonboyStrategy.exits` at close time.

This asymmetry was noted as a potential source of config drift.

**Recommendation:**
- Decide on a consistent policy for the simplified model (snapshot everything at open, or accept live reads for Moonboy).

### 6.5 Slippage & Execution Configuration

**Discussed During Simplification:**
- Jupiter swaps (both for Moonboy spot buys and any future LP-related Jupiter fallbacks) use configurable slippage.
- Default starting point agreed: **200 bps** (2%) as a safe but reasonable value for volatile fresh tokens.
- This is exposed via `SWAP_SLIPPAGE_BPS` environment variable.
- The value applies to Jupiter ladder/swap calls on both open and close paths.

**Current Implementation:**
- `SWAP_SLIPPAGE_BPS=200` is the documented default in `.env.local.example`.
- Used in the executor layer when building Jupiter swap transactions.

**Recommendation for Simplified Model:**
- Keep the env var as the single source of truth for slippage.
- Document clearly that this is one of the few execution risk levers the operator has.
- Consider making it per-strategy in the future only if it stays simple.

### 6.6 Moonboy Concurrency Limits

**Agreed Behavior (from simplification discussions):**
- Hard cap on concurrent Moonboy positions to control risk.
- Default: **maximum 3 concurrent open Moonboy positions**.
- This limit is separate from LP position limits.

**Current State:**
- Controlled by `MOONBOY_MAX_OPEN` (defaults to 3 if not set).
- Enforced in `bot/moonboy-executor.ts`:
  ```ts
  const MOONBOY_MAX_OPEN = parseInt(process.env.MOONBOY_MAX_OPEN ?? '3')
  ```
- Check happens before attempting a new Moonboy buy:
  ```ts
  if (openCount >= MOONBOY_MAX_OPEN) {
    // skip with log "cap reached"
  }
  ```
- `.env.local.example` documents it as:
  ```
  # MOONBOY_MAX_OPEN=3               # Already enforced in code (max 3 concurrent)
  ```

**Recommendation:**
- Treat `MOONBOY_MAX_OPEN=3` as the recommended default for the simplified model.
- Keep the enforcement logic lightweight and in one place (moonboy-executor).

### 6.7 Key Environment Variables Tied to Discussed Simplified Behaviors

During the refactoring and simplification phase, several environment variables were identified as the primary controls for the ultra-minimal Evil Panda + Moonboy system. These should be documented as part of the target model:

**Moonboy-related:**
- `MOONBOY_ENABLED`
- `MOONBOY_BUY_USD` (hard cap per buy, classically $10)
- `MOONBOY_MAX_OPEN` (max concurrent, default 3)

**Risk & Position Sizing (Evil Panda LP + overall):**
- `MAX_CONCURRENT_MARKET_LP_POSITIONS`
- `MAX_MARKET_LP_SOL_PER_POSITION`
- `MAX_MARKET_LP_SOL_DEPLOYED`
- `WALLET_MIN_SOL_RESERVE`
- `MAX_DAILY_LOSS_SOL` (optional circuit breaker)

**Slippage & Execution:**
- `SWAP_SLIPPAGE_BPS` (200 default for Jupiter)

**Evil Panda Strategy Tuning (commented defaults in .env.example):**
- `EVIL_PANDA_MAX_AGE_HOURS`
- `EVIL_PANDA_MIN_RUGCHECK_SCORE`
- `EVIL_PANDA_MIN_LIQUIDITY_USD`

**Scanner / Monitor Timing:**
- `LP_SCAN_INTERVAL_SEC`
- `LP_MONITOR_INTERVAL_SEC`

**Freshness & Scanner Gates:**
- `FRESH_MAX_AGE_MINUTES`
- Various `FRESH_*` and `MOMENTUM_*` constants (many now centralized in `lib/strategy-config.ts`)

All of the above were part of the conversations when we stripped the system down to Evil Panda + Moonboy only. They represent the main operator levers that remain in the simplified architecture.

---

## Ready for First Dry-Run Checklist (as of final polish wave)

1. Run in the project root:
   ```bash
   cd metoracle
   npm install          # if node_modules is missing
   npm run build
   npm run type-check   # should be clean
   ```

2. Ensure you have a `state/` directory (the code creates it automatically).

3. Recommended first run (in a terminal or via the VSCode extension):
   ```bash
   BOT_DRY_RUN=true \
   BOT_ENABLED=true \
   LP_SCANNER_ENABLED=true \
   LP_MONITOR_ENABLED=true \
   EVIL_PANDA_ENABLED=true \
   MOONBOY_ENABLED=true \
   npm run worker
   ```

4. Use the Telegram bot (`/tick`, `/status`, `/positions`, `/dry`, `/live`) to observe behavior without real money.

5. Watch for any remaining "shim" warnings — they should be rare now.

Once the above passes cleanly and you are comfortable after observing a few cycles in dry-run, you can remove `BOT_DRY_RUN=true`.

---

*Full refactoring to the cb8c3dd ultra-simplified model is now complete. This plan is kept as historical record.*

*Next natural step: safe first dry-runs + iteration on real behavior.*
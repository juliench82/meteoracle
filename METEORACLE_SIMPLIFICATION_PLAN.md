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
- **deep-checker.ts**: 939 lines (was 1147 before aggressive cuts)
  - Major progress: Removed two-track snipe/mature system, heavy JSON event logging, rich per-candidate diagnostics, complex bin compatibility scoring, `hasStrong5mSignal` + dynamic range logic, most "observation mode" spam.
  - Still carries some legacy structure and transitional comments.
- **lane-classifier.ts**: 160 lines (was 232)
  - Now the clean, authoritative, small core (good).
  - Honest simple classification logic.
- **pool-fetcher.ts**: 521 lines
  - Mostly acceptable (some optional Supabase cache paths remain behind flags).

**Overall Scanner Alignment**: Significantly improved, but not yet "ultra-simple".

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

## 5. Current Priority (May 30, 2026)

**Continue aggressive simplification on the scanner** (Phase 1).

We will keep making substantial cuts to `deep-checker.ts` and related areas until the scanner genuinely reflects the simplified vision.

---

*This plan lives in the repo so it can be updated as we make progress.*
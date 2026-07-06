/**
 * bot/executor/open.ts (thin orchestrator after split)
 *
 * Delegates to:
 *  - ./open/bin-calc.ts   (range feasibility, discrete bin math, no-rent gate)
 *  - ./open/pre-swap.ts   (direct DLMM SOL->token for bid-ask leg, actual delta)
 *  - lp-init / scaffold logic remains here for this pass (further extraction follows pattern)
 *  - persistence.ts (extended) for post-open recording
 *
 * External API (openPosition) and all behavior unchanged.
 * open.ts target <15KB via extraction.
 */

import {
  Keypair, PublicKey, Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  Connection,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import { logInfo, logError, logWarn } from '@/lib/log'
import { getOpenLpPositions } from '@/lib/local-state'
import type { StrategyType } from '@meteora-ag/dlmm'

import {
  getDLMM,
  getStrategyType,
  strategyTypeForDistribution,
  findStrategyForPosition,
  getTotalDeployedSolForCap,
  getTokenProgramId,
  getDecimalAdjustedPrice,
  getInitializePositionAccounts,
  ADD_LIQUIDITY_FALLBACK_CU,
  NATIVE_MINT_STR,
  METEORA_RENT_RESERVE_SOL,
  MARKET_LP_SOL_PER_POSITION,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MAX_MARKET_LP_SOL_DEPLOYED,
  WALLET_MIN_SOL_RESERVE,
} from './utils'

import { getConnection, getWallet, getPriorityFee, getHeliusRpcEndpoint } from '@/lib/solana'
import { getBotState } from '@/lib/botState'
import { sendAlert } from '@/bot/alerter'
import type { Strategy, TokenMetrics } from '@/lib/types'
import { getWalletTokenBalance } from '@/lib/swap'
import {
  OPEN_LP_STATUSES,
  getOpenLpLimitState,
  type OpenLpLimitState,
} from '@/lib/position-limits'
import { checkFullEvilPandaRangeFeasibility, assertNoNewBinArraysForRange } from './open/bin-calc'
import { swapSolToTokenDirectOnDlmm } from './open/pre-swap'
import {
  simulateAndCheck,
  sendLegacyTx,
  applyPriorityFee,
  addPriorityFeeAndPreserveComputeLimit,
  computeBudgetKind,
  COMPUTE_BUDGET_SET_UNIT_LIMIT,
} from '@/lib/solana-tx'

import {
  persistPosition,
  sendOpenAlert,
  findExistingActivePosition,
  persistStrandedTokenAfterFailedOpen,
  persistStrandedPositionRent,
  persistPendingScaffold,
  removePendingScaffold,
} from './persistence'

// swapTokenToSol (Jupiter) fully removed - using direct Meteora DLMM for all swaps in open/close/rollback

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'

// =============================================================================
// SECTION: Main openPosition flow
// =============================================================================








export async function openPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
): Promise<string | null> {
  const label = `[executor][${strategy.id}][${metrics.symbol}]`
  console.log(`${label} opening position`)

  // Hoisted for finally block (reclaim rent on failure paths, including early aborts)
  let positionKeypair: any = null;
  let dlmmPool: any = null;
  let minBinId = 0;
  let maxBinId = 0;
  let priorityFee = 0;
  let successfullyOpened = false;
  let positionScaffolded = false;
  let wallet: any = null;

  // Mark for graceful shutdown waiter (dynamic to avoid cycles; no globalThis mirror)
  import('../../worker').then((m: any) => m.setOpenInProgress?.(true)).catch(() => {})

  const botState = await getBotState()
  const DRY_RUN = ENV_DRY_RUN_FORCED || botState.dry_run

  if (botState.paused || botState.enabled === false) {
    console.log(`${label} bot is paused or disabled — skipping open`)
    return null
  }

  // Very loud early visibility for dry-run state (helps debug VPS env loading issues)
  console.log(
    `${label} DRY_RUN effective value: ${DRY_RUN} ` +
    `(ENV_FORCED=${ENV_DRY_RUN_FORCED}, botState.dry_run=${botState.dry_run})`
  )


  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)

    // Idempotency guard: prevent duplicate inserts into lp_positions during long dry-run observation.
    // Dry-run rows live only in local state, so the scanner guards
    // can be bypassed on later ticks → we must defend here too.
    let existing = null;
    try {
      existing = await findExistingActivePosition(metrics.address);
    } catch (e) {
      console.warn(`${label} DRY RUN — findExistingActivePosition failed (safe to continue without dedup)`);
    }
    if (existing) {
      console.log(`${label} DRY RUN — ${metrics.symbol} already has active simulation row (id=${existing.id}). Skipping duplicate persist to avoid lp_positions_mint_open_unique violation.`)
      return existing.id
    }

    const envCap = MARKET_LP_SOL_PER_POSITION
    const dryRunSolAmount = strategy.position.maxSolPerPosition
      ? Math.min(strategy.position.maxSolPerPosition, envCap)
      : envCap
    console.log(`${label} DRY RUN — creating new simulation row for ${metrics.symbol} (first time this tick/scan)`)
    const positionId = await persistPosition(metrics, strategy, 'dry-run-sig', metrics.priceUsd ?? 0, 0, dryRunSolAmount, undefined, 0, DRY_RUN)
    await sendOpenAlert(metrics, strategy, positionId, dryRunSolAmount, 0)
    return positionId
  }

  const connection = getConnection()
  wallet = getWallet()

  const envCap = MARKET_LP_SOL_PER_POSITION
  const solAmount = strategy.position.maxSolPerPosition
    ? Math.min(strategy.position.maxSolPerPosition, envCap)
    : envCap

    const eligibility = await validateOpenEligibility(label, metrics, strategy, solAmount, connection, wallet);
    if (!eligibility.ok) {
      return null;
    }

    const { limitState, poolPubkey } = eligibility;

    console.log(
      `${label} market LP cap ok (${limitState.effectiveOpenCount || 0}/${MAX_CONCURRENT_MARKET_LP_POSITIONS})`,
    );

    console.log(`${label} [TRACE] Starting open flow for pool ${metrics.poolAddress} — all early checks passed, no money spent yet`);
    console.log(`${label} [TRACE] [PRE-SCAFFOLD-STATE] positionScaffolded=false successfullyOpened=false — NO RENT PAID YET`);

    // Snapshot balances right at open flow entry (pre-any spend)
    try {
      const bal0 = await connection.getBalance(wallet.publicKey);
      console.log(`${label} [TRACE] [BAL-SNAPSHOT] entry wallet SOL=${(bal0 / 1e9).toFixed(9)} (no position rent or swap yet)`);
    } catch (e) { console.log(`${label} [TRACE] [BAL-SNAPSHOT] entry balance read failed: ${e}`); }

    const DLMM = await getDLMM()
    dlmmPool = await DLMM.create(connection, poolPubkey)
    const activeBin = await dlmmPool.getActiveBin()
    const initialActiveBinId = activeBin.binId

    const entryPriceSol = getDecimalAdjustedPrice(dlmmPool, activeBin)
    console.log(`${label} entry price: ${entryPriceSol.toFixed(9)} SOL/token (bin ${initialActiveBinId})`)
    console.log(`${label} [TRACE] DLMM pool created, activeBin=${initialActiveBinId}, binStep=${dlmmPool.lbPair.binStep}`);

    const binStep = dlmmPool.lbPair.binStep
    const mintX = dlmmPool.tokenX.publicKey
    const mintY = dlmmPool.tokenY.publicKey
    const solIsTokenX = mintX.toBase58() === NATIVE_MINT_STR
    const solIsTokenY = mintY.toBase58() === NATIVE_MINT_STR

    const outputMint = solIsTokenX ? mintY : mintX
    const isToken2022 = (await getTokenProgramId(outputMint)).toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()

    console.log(`${label} Token program resolved for output mint ${outputMint.toBase58().slice(0, 8)} → ${isToken2022 ? 'Token-2022' : 'Legacy Token'}`)

    // Compute priority fee early so it is available for pre-scaffold simulations and early aborts.
    priorityFee = await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()])
    console.log(`${label} priority fee: ${priorityFee} microlamports`)

    // =============================================================================
    // Desired range calculation (-50% / +100% target) + bin array existence gate
    //
    // We do NOT enforce literal -50.00% / +100.00%.
    // Meteora always snaps to discrete bin boundaries, so you typically get something
    // like -49.78% / +99.34% (or similar). This is expected and fine.
    //
    // We use Math.round() to get the closest achievable number of bins on each side.
    // The only hard gate is: the bin arrays for that range must already exist
    // (newBinArrayCount === 0) → zero non-refundable rent cost.
    //
    // This is the core of the "free-range" / "no artificial cap" design.
    // We want the largest possible evil-panda range the current on-chain state allows.
    // =============================================================================
    const rangeDownPct = strategy.position.rangeDownPct;
    const rangeUpPct = strategy.position.rangeUpPct;

    let feasibility = await checkFullEvilPandaRangeFeasibility(
      connection,
      poolPubkey,
      rangeDownPct,
      rangeUpPct
    );

    const rentPerArray = await connection.getMinimumBalanceForRentExemption(3472) / 1e9;
    const nonRefundCost = (feasibility.newBinArrayCount * rentPerArray).toFixed(2);
    console.log(
      `${label} Desired range cost check: ${feasibility.totalBins} bins would require ` +
      `${feasibility.newBinArrayCount} new bin array(s) (~${nonRefundCost} SOL non-refundable)`
    );

    if (!feasibility.feasible) {
      // Active bin drift detection (Claude suggestion): the active bin can move between the
      // initial fetch (used for entry price) and the range feasibility check. If it drifted,
      // the "infeasible" result may be transient. Give it one short retry with fresh state.
      if (feasibility.activeBinId !== initialActiveBinId) {
        console.log(
          `${label} active bin drifted (initial=${initialActiveBinId}, feasibility=${feasibility.activeBinId}) — ` +
          `waiting 1500ms and retrying full evil-panda range feasibility once`
        );
        await new Promise(r => setTimeout(r, 1500));
        feasibility = await checkFullEvilPandaRangeFeasibility(
          connection,
          poolPubkey,
          rangeDownPct,
          rangeUpPct
        );
      }

      if (!feasibility.feasible) {
        console.log(
          `${label} SKIPPING: full evil-panda range (-50% / +100%) not possible with zero new bin arrays ` +
          `(would need ${feasibility.newBinArrayCount} new array(s) for ${feasibility.totalBins} bins @ step=${feasibility.binStep}). ` +
          `This is by design — we only open when the entire desired discrete range is already populated on-chain (no non-refundable rent). ` +
          `Waiting for other LPs to create the missing bin arrays.`
        );
        return null;
      } else {
        console.log(`${label} range feasibility recovered after active bin drift retry`);
      }
    }

    // Use values from the centralized feasibility check (full range with 0 new bin arrays guaranteed here)
    minBinId = feasibility.minBinId;
    maxBinId = feasibility.maxBinId;
    const binRange = feasibility.totalBins;
    const fullBinsDown = feasibility.fullBinsDown;
    const fullBinsUp = feasibility.fullBinsUp;
    const effectiveDownPct = feasibility.effectiveDownPct;
    const effectiveUpPct = feasibility.effectiveUpPct;

    console.log(`${label} bin range validated: ${minBinId} → ${maxBinId} (${binRange} bins total, step=${feasibility.binStep}) (fullBinsDown=${fullBinsDown} fullBinsUp=${fullBinsUp} via geometric log math to match UI)`);

    console.log(
      `${label} effective coverage ~${effectiveDownPct.toFixed(1)}% / +${effectiveUpPct.toFixed(1)}% ` +
      `(desired was ${rangeDownPct}% / ${rangeUpPct}%; Meteora snaps to nearest discrete bins)`
    );

    console.log(`${label} [TRACE] About to run final bin-array assert and enter pre-scaffold checks. No rent paid yet.`);
    console.log(`${label} [TRACE] [VERIFICATION] Will now HARD VERIFY that chosen range ${minBinId}→${maxBinId} has ZERO missing bin arrays (no non-refundable rent).`);

    // Immediate verification after finalizing the exact bin ids we will use.
    await assertNoNewBinArraysForRange(dlmmPool, minBinId, maxBinId, label);
    console.log(`${label} [TRACE] [VERIFIED] assertNoNewBinArraysForRange PASSED for ${minBinId}→${maxBinId} — ZERO new bin arrays. Safe to proceed without non-refundable spend.`);

    // NOTE on range:
    // We deliberately do *not* hard-cap the number of bins here.
    // The whole point of the current design (vs the old artificial 70-bin / Zap limits)
    // is to allow full desired evil-panda ranges (-50% / +100% on binStep=100 → often 150+ bins)
    // as long as the required bin arrays already exist on-chain (the gate above).
    //
    // Meteora never gives you exactly the requested % because of discrete bin boundaries.
    // The Math.round() + the bin-array existence gate (enforced both here and early in deep-checker for evil-panda)
    // is the "subtle" part: we ask for the closest achievable discrete range and only open if it costs zero rent.

    if (!solIsTokenX && !solIsTokenY) {
      console.warn(`${label} pool has no SOL side — rejecting one-sided SOL`)
      logWarn('legacy_bot_log', {
        level: 'warn',
        event: 'open_position_skipped_non_sol_pair',
        payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress },
      })
      return null
    }

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)

    const totalSolLamports = BigInt(Math.floor(solAmount * 1e9))
    const binsTotal = fullBinsDown + fullBinsUp + 1  // +1 for the active bin

    // Safety guard: even with the split-tx pre-size + init, extremely wide position accounts can hit
    // other limits (program max bins per position, CU, or future on-chain changes). If the discrete
    // range math produced something absurd, skip *before* the pre-swap to avoid stranding tokens.
    const MAX_SAFE_NUM_BINS = 220; // ~28KB worst-case at our conservative 128B/bin estimate; well under account size limits
    const numBinsForGuard = (maxBinId - minBinId) + 1;
    if (numBinsForGuard > MAX_SAFE_NUM_BINS) {
      console.warn(`${label} SKIPPING: computed position spans ${numBinsForGuard} bins (range ${minBinId}→${maxBinId}) exceeds safe max ${MAX_SAFE_NUM_BINS}. Avoiding potential init or CU issues and pre-swap stranding.`);
      return null;
    }

    // Base allocation for the token leg is bin-proportional for value-matching the Bid-Ask range.
    // solBias (from strategy, default 1) allows tilting the split:
    //   - solBias = 1 : use exact bin proportion (current default behavior)
    //   - solBias > 1 : more SOL-heavy (swap less for token leg)
    //   - solBias < 1 : more token-heavy (swap more for token leg)
    // This makes the previously-unused solBias field actually control the economics.
    let swapFraction = fullBinsDown / binsTotal
    const solBias = Math.max(0.1, strategy.position.solBias ?? 1)
    swapFraction = swapFraction / solBias
    swapFraction = Math.max(0, Math.min(1, swapFraction))

    let solToSwapLamports = BigInt(Math.floor(Number(totalSolLamports) * swapFraction))
    if (solToSwapLamports < 0n) solToSwapLamports = 0n
    const remainingSolLamports = totalSolLamports - solToSwapLamports

    console.log(`${label} one-sided split for Bid-Ask: swap ${solToSwapLamports} lamports SOL for token side (fraction=${swapFraction.toFixed(4)}, solBias=${solBias}), keep ${remainingSolLamports} as SOL side`)

    // Guard against dust token leg (tiny positive amounts that would fail or be useless).
    // If solBias made it exactly 0 we allow pure-SOL leg (proceed without pre-swap).
    const MIN_SWAP_LAMPORTS = 10_000n;
    if (solToSwapLamports > 0n && solToSwapLamports < MIN_SWAP_LAMPORTS) {
      console.warn(`${label} token swap leg would be dust (${solToSwapLamports} lamports) — skipping pool to avoid stranded dust or SDK failure`);
      return null;
    }

    // Lightweight re-check of wallet balance immediately before the irreversible swap (protects against races
    // with other activity, prior failed txs, or balance changes since the earlier eligibility check).
    try {
      const currentBalLamports = await connection.getBalance(wallet.publicKey);
      const currentBalSol = currentBalLamports / 1e9;
      const requiredNow = solAmount + METEORA_RENT_RESERVE_SOL + WALLET_MIN_SOL_RESERVE;
      if (currentBalSol < requiredNow) {
        console.warn(`${label} balance dropped below required before swap — have ${currentBalSol.toFixed(4)}, need ~${requiredNow.toFixed(3)} — skipping`);
        return null;
      }
    } catch (balChkErr) {
      console.warn(`${label} balance re-check before swap failed (proceeding with caution):`, balChkErr);
    }

    // === Pre-flight position keypair + smart existence check (Bug 3) ===
    // Generate fresh keypair before any pre-swap.
    // - If free (no account or 0 lamports): use it, will need create.
    // - If exists and owned by DLMM program: reuse the address, skip create (and init if already has discriminator).
    // - If exists but other owner: collision, regenerate.
    // - After 3 fails to find usable: skip before swap.
    const DLMM_PROGRAM_ID = dlmmPool.program.programId.toBase58();
    positionKeypair = new Keypair();
    let needsCreate = true;
    let needsInitialize = true;
    for (let i = 0; i < 3; i++) {
      const existing = await connection.getAccountInfo(positionKeypair.publicKey).catch(() => null);
      if (!existing || existing.lamports === 0) {
        needsCreate = true;
        needsInitialize = true;
        break;
      }
      if (existing.owner.toBase58() === DLMM_PROGRAM_ID) {
        // Already allocated to the program from a prior partial attempt on this key.
        // Skip create. Check if it looks initialized (has substantial data beyond rent + header).
        needsCreate = false;
        const data = existing.data;
        needsInitialize = !(data && data.length > 100); // rough heuristic; init will be safe to attempt anyway
        console.log(`${label} position address ${positionKeypair.publicKey.toBase58().slice(0,8)} already DLMM-owned — skipping create, needsInit=${needsInitialize}`);
        break;
      }
      // Occupied by something else (or previous non-DLMM use)
      console.warn(`${label} position address ${positionKeypair.publicKey.toBase58().slice(0,8)} occupied by non-DLMM owner (${existing.owner.toBase58().slice(0,8)}) — regenerating fresh keypair`);
      positionKeypair = new Keypair();
    }
    const finalCheck = await connection.getAccountInfo(positionKeypair.publicKey).catch(() => null);
    if (finalCheck && finalCheck.lamports > 0 && finalCheck.owner.toBase58() !== DLMM_PROGRAM_ID) {
      console.error(`${label} could not obtain a clean DLMM-writable position keypair after 3 attempts — skipping to avoid pre-swap followed by unrecoverable collision`);
      return null;
    }

    // Persist only after final usable keypair confirmed (avoids stale entries for keypairs that failed finalCheck).
    persistPendingScaffold(
      positionKeypair.publicKey.toBase58(),
      positionKeypair.secretKey,
      dlmmPool.pubkey.toBase58(),
      typeof minBinId === 'number' ? minBinId : undefined,
      typeof maxBinId === 'number' ? maxBinId : undefined
    );

    console.log(`${label} [TRACE] Entering pre-scaffold phase: will compute planned swap amounts and run full tx simulation before any rent is paid.`);
    console.log(`${label} [TRACE] [PRE-SCAFFOLD-STATE] about to quote/swap-sim | solToSwapLamports=${solToSwapLamports} remainingSolLamports=${remainingSolLamports} | positionScaffolded=false`);
    try {
      const balPre = await connection.getBalance(wallet.publicKey);
      console.log(`${label} [TRACE] [BAL-SNAPSHOT] pre-quote wallet SOL=${(balPre / 1e9).toFixed(9)} — still no rent paid`);
    } catch {}

    // Pre-swap quote for planned token leg amount (used for add sim + split).
    // Done early, before any on-chain spend (scaffold rent), so we can abort without paying rent
    // if the swap quote itself looks bad (0 out or throws). This prevents paying the position rent
    // on cases where the pre-swap would fail.
    let plannedTokenLamportsForSim = 0n;
    if (solToSwapLamports > 0n) {
      try {
        console.log(`${label} [TRACE] [PRE-SCAFFOLD-QUOTE] calling dlmmPool.swapQuote for ${solToSwapLamports} lamports (slippage 500bps)`);
        const binArrays = await dlmmPool.getBinArrays();
        const swapYtoX = !solIsTokenX;
        const inputAmountBN = new BN(solToSwapLamports.toString());
        const swapQuote = await dlmmPool.swapQuote(inputAmountBN, swapYtoX, new BN(500), binArrays);
        const q = swapQuote as any;
        plannedTokenLamportsForSim = BigInt(q.outAmount.toString());
        console.log(`${label} [TRACE] [PRE-SCAFFOLD-QUOTE] Planned quote OK: outAmount=${plannedTokenLamportsForSim}, minOut=${(q.minOutAmount?.toString?.() ?? 'n/a')}`);
      } catch (qErr) {
        console.error(`${label} [TRACE] [PRE-SCAFFOLD-QUOTE-FAIL] pre-swap quote for sim failed (ABORT, NO RENT): ${qErr}`);
        console.error(`${label} pre-swap quote for sim failed: ${qErr}`);
        return null;
      }
    } else {
      console.log(`${label} [TRACE] [PRE-SCAFFOLD-QUOTE] solToSwapLamports=0 — skipping quote (pure SOL leg)`);
    }

    // Pre-scaffold swap quote viability gate (Claude recommendation).
    // If the planned swap would give zero tokens, abort *before* paying any position rent.
    // This is a pure read (no on-chain cost) and catches the main failure mode seen in production logs.
    if (solToSwapLamports > 0n && plannedTokenLamportsForSim === 0n) {
      console.log(`${label} [TRACE] [PRE-SCAFFOLD-ZERO] ZERO output from planned quote — ABORTING BEFORE scaffold. positionScaffolded=false successfullyOpened=false`);
      console.log(`${label} [TRACE] [NO-RENT-YET][VERIFIED] pre-swap quote gave zero output — skipping entire open (including scaffold rent) before any money is spent`);
      console.log(`${label} pre-swap quote gave zero output — skipping entire open (including scaffold rent) before any money is spent`);
      return null;
    }

    console.log(`${label} [TRACE] About to run full swap TX simulation (pre-scaffold). This is the critical gate that protects us from paying rent on bad candidates.`);

    // Pre-scaffold swap tx simulation (full tx sim, not just quote).
    // Builds the swap tx (using planned amounts) and runs simulateAndCheck before paying any position rent.
    // This catches more realistic failures (account setup, CU limits, program errors, bin array issues)
    // that a pure quote might miss. Zero on-chain cost.
    if (solToSwapLamports > 0n && plannedTokenLamportsForSim > 0n) {
      try {
        console.log(`${label} [TRACE] [PRE-SCAFFOLD-SIM] fetching binArrays + building full swap tx for simulateAndCheck`);
        const binArrays = await dlmmPool.getBinArrays();
        const swapYtoX = !solIsTokenX;
        const inputAmountBN = new BN(solToSwapLamports.toString());
        const swapQuote = await dlmmPool.swapQuote(inputAmountBN, swapYtoX, new BN(500), binArrays);
        const q = swapQuote as any;
        const binArrayKeysForSwap = binArrays.map((ba: any) => ba.publicKey);
        const inToken = solIsTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
        const outToken = solIsTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;
        const swapTx = await dlmmPool.swap({
          inToken,
          binArraysPubkey: binArrayKeysForSwap,
          inAmount: inputAmountBN,
          lbPair: dlmmPool.pubkey,
          user: wallet.publicKey,
          minOutAmount: q.minOutAmount,
          outToken,
        });
        const prepared = applyPriorityFee(swapTx, priorityFee);
        console.log(`${label} [TRACE] [PRE-SCAFFOLD-SIM] swap tx constructed, calling simulateAndCheck now (pre-rent)`);
        const simOk = await simulateAndCheck(prepared, `${label} [pre-scaffold-swap-tx-sim]`);
        if (!simOk) {
          console.log(`${label} [TRACE] [PRE-SCAFFOLD-SIM-FAIL] Swap TX sim FAILED — ABORT before scaffold. positionScaffolded=false NO RENT PAID`);
          console.log(`${label} [TRACE] [NO-RENT-YET] pre-scaffold swap tx simulation failed — aborting before paying position rent`);
          console.log(`${label} pre-scaffold swap tx simulation failed — aborting before paying position rent`);
          return null;
        }
        console.log(`${label} [TRACE] [PRE-SCAFFOLD-SIM-OK] Swap TX simulation PASSED ✔ Safe to proceed to scaffold rent (still zero rent paid at this point).`);
        console.log(`${label} [pre-scaffold] swap tx simulation OK`);
      } catch (simErr) {
        console.error(`${label} [TRACE] [PRE-SCAFFOLD-SIM-THROW] Swap TX sim threw — ABORT before scaffold. positionScaffolded=false`);
        console.error(`${label} [TRACE] [NO-RENT-YET] pre-scaffold swap tx sim threw: ${simErr}`);
        console.error(`${label} pre-scaffold swap tx sim threw: ${simErr}`);
        return null;
      }
    } else {
      console.log(`${label} [TRACE] [PRE-SCAFFOLD-SIM-SKIP] skipping full tx sim (no swap leg or zero planned output)`);
    }

    const plannedTotalX = solIsTokenX ? new BN(remainingSolLamports.toString()) : new BN(plannedTokenLamportsForSim.toString());
    const plannedTotalY = solIsTokenY ? new BN(remainingSolLamports.toString()) : new BN(plannedTokenLamportsForSim.toString());

    // Final hard verification right before we pay any position rent.
    // This is the critical "no non-refundable bin arrays" guard.
    console.log(`${label} [TRACE] [FINAL-PRE-RENT-VERIFY] About to assert no new bin arrays ONE FINAL TIME before paying ANY rent.`);
    console.log(`${label} [TRACE] [FINAL-PRE-RENT-VERIFY] plannedTotalX=${plannedTotalX.toString()} plannedTotalY=${plannedTotalY.toString()}`);
    try {
      const balPreRent = await connection.getBalance(wallet.publicKey);
      console.log(`${label} [TRACE] [BAL-SNAPSHOT] immediately pre-rent wallet SOL=${(balPreRent / 1e9).toFixed(9)}`);
    } catch {}
    await assertNoNewBinArraysForRange(dlmmPool, minBinId, maxBinId, label);
    console.log(`${label} [TRACE] [VERIFIED-NO-NONREFUNDABLE] ✅✅✅ FINAL assert PASSED — range ${minBinId}→${maxBinId} has 0 new bin arrays. WE ARE NOT BUYING INTO NONE-REFUNDABLE BIN STEPS.`);
    console.log(`${label} [TRACE] [VERIFIED-NO-NONREFUNDABLE] About to set positionScaffolded=true and pay rent.`);

    positionScaffolded = false;
    successfullyOpened = false;

    try {
      console.log(`${label} [TRACE] [SCAFFOLD-START] Entering scaffold block NOW — next logs will show rent being spent. positionScaffolded will flip to true.`);
      console.log(`${label} [TRACE] [SCAFFOLD-STATE] positionScaffolded=${positionScaffolded} successfullyOpened=${successfullyOpened}`);
      // =============================================================================
      // REAL SCAFFOLDING (create + initialize) — BEFORE pre-swap and before add pre-sim gate.
      // Per corrected flow: cheap fixed-cost steps first so the position account + discriminator
      // exist on-chain. This makes the subsequent add pre-sim *meaningful*.
      // Only after this + passing add sim do we do the irreversible token pre-swap.
      //
      // TRADEOFF (acknowledged): position rent is paid before the add pre-sim can fail.
      // The pre-scaffold swap quote + tx simulation (earlier in this function) is the primary
      // guard that prevents us from reaching this point on bad candidates.
      // The finally block at the end of this scope ensures we attempt to close the empty
      // position and reclaim rent on ANY abort after scaffolding.
      // =============================================================================
      const lowerBinId = minBinId;
      const width = maxBinId - minBinId;
      const numBins = width + 1;
      const POSITION_HEADER = 256;
      const BYTES_PER_BIN = 128;
      const positionAccountSize = Math.max(POSITION_HEADER + numBins * BYTES_PER_BIN, 8192);
      const positionRentLamports = await connection.getMinimumBalanceForRentExemption(positionAccountSize);

      // CRITICAL: bundle createAccount + initializePosition into a SINGLE atomic transaction
      // when both are needed. This prevents the previous failure mode where create landed
      // (rent paid, ~0.13 SOL locked), then a separate initializePosition tx sim/send failed
      // ("already in use" / discriminator / owned-by-wrong), leaving an uninitialized position
      // account with no automatic reclaim because positionScaffolded was never set.
      // With bundle: the sim happens on the combined tx; if it would fail, we abort with ZERO
      // rent paid. If it succeeds and lands, both create+init happened atomically.
      const scaffoldIxs: TransactionInstruction[] = [];

      if (needsCreate) {
        console.log(
          `${label} [TRACE] [SCAFFOLD-CREATE] phase 1a (early): creating position account (space=${positionAccountSize} bytes, rent≈${(positionRentLamports / 1e9).toFixed(9)} SOL) for ${numBins} bins`
        );
        const createPositionAccountIx = SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: positionKeypair.publicKey,
          lamports: positionRentLamports,
          space: positionAccountSize,
          programId: dlmmPool.program.programId,
        });
        scaffoldIxs.push(createPositionAccountIx);
      } else {
        console.log(`${label} [TRACE] [SCAFFOLD-CREATE-SKIP] phase 1a skipped — position account already DLMM-owned`);
        console.log(`${label} phase 1a skipped — position account already DLMM-owned`);
      }

      if (needsInitialize) {
        console.log(`${label} [TRACE] [SCAFFOLD-INIT] phase 1b (early): initializePosition (lower=${lowerBinId}, width=${width})`);
        const initializePositionIx = await dlmmPool.program.methods
          .initializePosition(lowerBinId, width)
          .accounts(
            getInitializePositionAccounts(
              dlmmPool,
              wallet.publicKey,
              positionKeypair.publicKey,
              dlmmPool.pubkey
            )
          )
          .instruction();
        scaffoldIxs.push(initializePositionIx);
      } else {
        console.log(`${label} [TRACE] [SCAFFOLD-INIT-SKIP] phase 1b skipped — position appears already initialized`);
        console.log(`${label} phase 1b skipped — position appears already initialized`);
      }

      if (scaffoldIxs.length > 0) {
        // Last-second defensive check: the account must still not exist.
        // With a fresh random keypair this is virtually certain, but prevents any
        // weird "we just created it in a prior partial attempt" or collision surprises.
        const preBundleCheck = await connection.getAccountInfo(positionKeypair.publicKey).catch(() => null);
        if (preBundleCheck && preBundleCheck.lamports > 0) {
          console.error(`${label} [TRACE] [SCAFFOLD-BUNDLE-ABORT] position keypair suddenly exists on-chain right before bundle — aborting to avoid double-spend or conflict. No rent paid.`);
          return null;
        }

        const scaffoldTx = new Transaction();
        scaffoldIxs.forEach((ix) => scaffoldTx.add(ix));
        const scaffoldPrep = applyPriorityFee(scaffoldTx, priorityFee);
        const what = needsCreate && needsInitialize ? 'create+init (bundled atomic)' : needsCreate ? 'create' : 'init';
        console.log(`${label} [TRACE] [SCAFFOLD-BUNDLE] sending combined ${what} tx (atomic — if sim fails here, ZERO rent paid)...`);
        const scaffoldSig = await sendLegacyTx(scaffoldPrep, [wallet, positionKeypair], `${label} position-scaffold`);
        console.log(`${label} [TRACE] [SCAFFOLD-BUNDLE] ${what} COMPLETE ✔ sig: ${scaffoldSig}`);
        console.log(`${label} position scaffold complete ✔ sig: ${scaffoldSig}`);

        // Scaffold succeeded atomically (create+init or equivalent). No longer need the secret for recovery.
        removePendingScaffold(positionKeypair.publicKey.toBase58());

        // Post-success verification snapshot (best effort)
        try {
          const after = await connection.getAccountInfo(positionKeypair.publicKey);
          console.log(`${label} [TRACE] [SCAFFOLD-VERIFY] after bundle: owner=${after?.owner?.toBase58?.().slice(0,8)} lamports=${after?.lamports} dataLen=${after?.data?.length}`);
        } catch {}
      }

      positionScaffolded = scaffoldIxs.length > 0;
      console.log(`${label} [TRACE] [SCAFFOLD-DONE] positionScaffolded=TRUE, rent paid.`);
      console.log(`${label} [TRACE] SCAFFOLD COMPLETE — rent paid for position account.`);
      console.log(`${label} Position account scaffolded (rent paid). Add pre-sim and swap will follow. Rent will be reclaimed on any failure via finally.`);
      console.log(`${label} [TRACE] [SCAFFOLD-STATE] positionScaffolded=${positionScaffolded} successfullyOpened=${successfullyOpened}`);

      console.log(`${label} [TRACE] [POST-SCAFFOLD] Starting post-scaffold add pre-sim gate on *LIVE* initialized account (using planned amounts). positionScaffolded=${positionScaffolded}`);

    // Post-scaffold add pre-sim using *planned* amounts REMOVED.
    // The accurate sim (with actual post-swap amounts) runs inside openPositionDirect.
    // Pre-scaffold swap sim remains the early gate before rent is paid.
    console.log(`${label} [TRACE] [POST-SCAFFOLD-PRE-SIM-SKIPPED] Skipping redundant planned-amount add sim (actual sim inside openPositionDirect).`);

    console.log(`${label} [TRACE] [DRIFT-CHECK] Starting last-second active bin drift check before pre-swap.`);
    console.log(`${label} [TRACE] [DRIFT-CHECK] initialActiveBinId=${initialActiveBinId} positionScaffolded=${positionScaffolded}`);

    // Last-second active bin sanity check before the irreversible pre-swap.
    // Active bin can drift on volatile pools between feasibility/scaffold/pre-sim and now.
    try {
      const currentActive = await dlmmPool.getActiveBin();
      const binDrift = Math.abs(currentActive.binId - initialActiveBinId);
      const binStep = dlmmPool.lbPair.binStep;
      const driftThreshold = Math.max(3, Math.ceil(50 / binStep)); // ~0.5% price drift tolerance; scale for high binStep pools
      console.log(`${label} [TRACE] [DRIFT-CHECK] re-fetched activeBin=${currentActive.binId} drift=${binDrift} (threshold=${driftThreshold} for binStep=${binStep})`);
      if (binDrift > driftThreshold) {
        console.warn(`${label} [TRACE] [DRIFT-ABORT] DRIFT DETECTED — aborting before pre-swap. positionScaffolded=${positionScaffolded} will trigger finally close.`);
        console.warn(`${label} active bin drifted significantly (initial=${initialActiveBinId}, now=${currentActive.binId}, drift=${binDrift}, threshold=${driftThreshold}) — aborting before pre-swap to avoid out-of-range position`);
        return null;
      }
      console.log(`${label} [TRACE] [DRIFT-OK] Active bin drift OK (drift=${binDrift} <= ${driftThreshold}). Safe to continue.`);
    } catch (driftErr) {
      console.warn(`${label} [TRACE] [DRIFT-WARN] failed to re-check active bin before swap (proceeding with caution): ${driftErr}`);
      console.warn(`${label} failed to re-check active bin before swap (proceeding with caution): ${driftErr}`);
    }

    console.log(`${label} [TRACE] [LATE-ATA] Post-drift check passed. About to ensure (late) ATA for output token only (only after sim gate).`);

    // Create the required ATA (only the non-SOL token side) at the last responsible moment.
    // Only after pre-sim gate passes. If it doesn't exist, create it now.
    // This avoids wasting ATA rent on candidates that fail the add pre-sim.
    const outputMintForAta = solIsTokenX ? mintY : mintX;
    if (outputMintForAta.toBase58() !== NATIVE_MINT_STR) {
      try {
        const tokenProgramId = await getTokenProgramId(outputMintForAta);
        const ata = getAssociatedTokenAddressSync(outputMintForAta, wallet.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
        const ataExists = !!(await connection.getAccountInfo(ata));
        console.log(`${label} [TRACE] [LATE-ATA] checking ATA for ${outputMintForAta.toBase58().slice(0,8)} exists=${ataExists}`);
        if (!ataExists) {
          console.log(`${label} [TRACE] [LATE-ATA] ATA missing — creating now (after all gates).`);
          console.log(`${label} creating ATA for output token ${outputMintForAta.toBase58().slice(0, 8)}…`);
          const ataIx = createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey, ata, wallet.publicKey, outputMintForAta, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
          );
          const ataTx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ataIx
          );
          const ataSig = await sendLegacyTx(ataTx, [wallet], label);
          console.log(`${label} [TRACE] [LATE-ATA] ATA creation tx sent ✔ sig: ${ataSig}`);
          console.log(`${label} ATA created ✔ sig: ${ataSig}`);
        } else {
          console.log(`${label} [TRACE] [LATE-ATA] Output token ATA already existed — no creation needed.`);
        }
      } catch (ataErr) {
        console.error(`${label} [TRACE] [LATE-ATA-FAIL] ATA creation failed — will trigger finally close. positionScaffolded=${positionScaffolded}`);
        console.error(`${label} [TRACE] ATA creation failed — will trigger finally close.`);
        console.error(`${label} failed to ensure ATA for output token — closing scaffolded position and aborting`);
        return null;
      }
    } else {
      console.log(`${label} [TRACE] [LATE-ATA-SKIP] Output side is SOL — no ATA needed.`);
    }

    console.log(`${label} [TRACE] [ALL-GATES-PASSED] All pre-swap gates passed (sim, drift, ATA). About to do the real (irreversible) pre-swap.`);
    console.log(`${label} [TRACE] [PRE-SWAP-STATE] positionScaffolded=${positionScaffolded} successfullyOpened=${successfullyOpened}`);
    try {
      const balPreSwap = await connection.getBalance(wallet.publicKey);
      console.log(`${label} [TRACE] [BAL-SNAPSHOT] pre-swap (post-scaffold+pre-sim) wallet SOL=${(balPreSwap / 1e9).toFixed(9)}`);
    } catch {}

    let actualTokenLamports = 0n
    if (solToSwapLamports > 0n) {
      // Prefer direct swap on the DLMM pool itself using Meteora SDK (native swap, no Jupiter).
      // Meteora UI exposes swap on DLMM pools; the SDK has swapQuote + swap for exactly this.
      // Since the pool already passed the full evil-panda range gate (bin arrays exist and populated),
      // direct swap on this pool is the natural way to acquire the token leg for the Bid-Ask.
      // This completely bypasses Jupiter 0x177e issues for these specific pools.
      // Last-chance verification before the irreversible pre-swap.
      await assertNoNewBinArraysForRange(dlmmPool, minBinId, maxBinId, label);

      console.log(`${label} [TRACE] [PRE-SWAP-EXEC] attempting direct DLMM swap for token leg (Meteora SDK native, bypassing Jupiter)`);
      console.log(`${label} [TRACE] [PRE-SWAP-EXEC] solToSwapLamports=${solToSwapLamports} outputMint=${outputMint.toBase58().slice(0,8)}`);
      try {
        actualTokenLamports = await swapSolToTokenDirectOnDlmm(
          dlmmPool,
          solToSwapLamports,
          outputMint,
          solIsTokenX,
          label
        );
        console.log(`${label} [TRACE] [PRE-SWAP-EXEC] swapSolToTokenDirectOnDlmm returned ${actualTokenLamports}`);
        if (actualTokenLamports > 0n) {
          console.log(`${label} [TRACE] [PRE-SWAP-OK] Pre-swap swap completed successfully. Received ${actualTokenLamports} tokens.`);
        }
      } catch (directErr) {
        console.error(`${label} [TRACE] [PRE-SWAP-FAIL] Pre-swap FAILED — will trigger finally close to reclaim rent. positionScaffolded=${positionScaffolded}`);
        console.error(`${label} [TRACE] Pre-swap FAILED — will trigger finally close to reclaim rent.`);
        console.error(`${label} direct DLMM swap for token leg FAILED: ${directErr instanceof Error ? directErr.message : directErr}`);
        console.error(`${label} (Jupiter completely ditched per user request — no fallback; skipping pool)`);
        // Pre-swap tx may have confirmed on-chain (sendLegacyTx throws on confirm/status fallback fail even if landed).
        // Query fresh balance and persist stranded token marker for monitor recovery (sell back) if we hold any.
        try {
          const fresh = await getWalletTokenBalance(outputMint.toBase58()).catch(() => 0n)
          if (fresh > 0n) {
            await persistStrandedTokenAfterFailedOpen(metrics, outputMint.toBase58(), fresh)
            console.warn(`${label} persisted stranded marker for ${fresh} after pre-swap throw (tx likely landed)`)
          }
        } catch (pErr) {
          console.warn(`${label} could not persist stranded after pre-swap throw:`, pErr)
        }
        return null;
      }
    } else if (solToSwapLamports === 0n) {
      console.log(`${label} [TRACE] [PRE-SWAP-SKIP] solToSwapLamports=0 — no pre-swap executed (pure SOL leg)`);
    }

    const MIN_REMAINING_SOL_FOR_ADD = 10_000n; // dust guard to avoid adding near-zero after rent paid
    if (remainingSolLamports < MIN_REMAINING_SOL_FOR_ADD && actualTokenLamports < 1_000_000n) {
      console.warn(`${label} [TRACE] [ADD-GUARD] remainingSol + token too small for add after scaffold — aborting`);
      // If we acquired tokens via pre-swap before this guard, ensure stranded marker
      if (actualTokenLamports > 0n) {
        try {
          const fresh = await getWalletTokenBalance(outputMint.toBase58()).catch(() => actualTokenLamports)
          if (fresh > 0n) await persistStrandedTokenAfterFailedOpen(metrics, outputMint.toBase58(), fresh)
        } catch {}
      }
      return null;
    }

    if (solToSwapLamports > 0n && actualTokenLamports === 0n) {
      console.error(`${label} [TRACE] [PRE-SWAP-ZERO] Pre-swap returned 0 tokens — will trigger finally close. positionScaffolded=${positionScaffolded}`);
      console.error(`${label} [TRACE] Pre-swap returned 0 tokens — will trigger finally close.`);
      console.error(`${label} direct DLMM swap returned 0 tokens for full-range pool (Jupiter completely ditched) — skipping pool`);
      // The pre-swap tx may still have landed (e.g. PARQ case: sig confirmed but post-swap balance query saw 0 due to
      // Token-2022/hook visibility). Persist a stranded marker using a fresh query so the monitor recovery can clean it.
      try {
        const fresh = await getWalletTokenBalance(outputMint.toBase58());
        if (fresh > 0n) {
          await persistStrandedTokenAfterFailedOpen(metrics, outputMint.toBase58(), fresh);
          console.warn(`${label} persisted stranded marker for ${fresh} raw units of ${outputMint.toBase58().slice(0,8)} (pre-swap landed but reported 0)`);
        }
      } catch (e) {
        console.warn(`${label} could not persist stranded for 0-reported pre-swap:`, e);
      }
      return null;
    }

    if (solToSwapLamports > 0n) {
      console.log(`${label} [TRACE] Pre-swap done. Received ${actualTokenLamports} tokens. About to call openPositionDirect for the add.`);
      console.log(`${label} swap done: received ${actualTokenLamports} token lamports`);
    }

    // (positionKeypair was already generated + pre-flight checked earlier, before the pre-swap)

    console.log(`${label} [TRACE] [ADD-STEP] About to call openPositionDirect (the actual add/fund step).`);
    console.log(`${label} [TRACE] [ADD-STEP] remainingSolLamports=${remainingSolLamports} actualTokenLamports=${actualTokenLamports}`);

    // === DIRECT (using remaining SOL + actual received token from any pre-swap) ===
    console.log(`${label} [TRACE] [ADD-STEP] attempting direct (Bid-Ask range) with computed legs`);
    console.log(`${label} attempting direct (Bid-Ask range) with computed legs`);
    const directResult = await openPositionDirect(
      metrics,
      strategy,
      dlmmPool,
      poolPubkey,
      outputMint,
      solAmount,  // budgeted target; effectiveDeployedSol is computed inside from actual post-swap lamports + entry price
      minBinId,
      maxBinId,
      solIsTokenX,
      label,
      priorityFee,
      DRY_RUN,
      positionKeypair,
      remainingSolLamports,
      actualTokenLamports,
      positionScaffolded // skip inner scaffold if early one succeeded
    );
    if (directResult) {
      successfullyOpened = true;
      console.log(`${label} [TRACE] [SUCCESS] directResult=${directResult} successfullyOpened=true`);
      console.log(`${label} [TRACE] FULL SUCCESS — position opened and persisted. No close needed in finally.`);
      console.log(`${label} position opened successfully via direct SDK ✔`);
      import('../../worker').then((m: any) => m.setOpenInProgress?.(false)).catch(() => {})
      return directResult;
    }

    console.log(`${label} [TRACE] [ADD-FAILED] openPositionDirect returned null — will enter rollback then finally close. positionScaffolded=${positionScaffolded} successfullyOpened=${successfullyOpened}`);

    // Rollback path: position creation failed after successful direct DLMM pre-swap.
    // Use direct DLMM sell (Meteora native) to return tokens to SOL. (Jupiter fully ditched.)
    // IMPORTANT: re-query the *current* token balance right now (the pre-swap "actualTokenLamports"
    // may be stale/huge/wrong due to prior bugs or the failed open attempt). Use looser slippage
    // for the emergency sell so we don't strand on 0x1773 like before.
    console.error(`${label} position open failed after successful pre-swap — attempting DIRECT DLMM rollback sell to SOL`);
    // Refresh priority for time-critical rollback (may be stale from initial capture)
    const rollbackPriority = Math.max(priorityFee, await getPriorityFee([dlmmPool.pubkey.toBase58(), wallet.publicKey.toBase58()]).catch(() => 50_000));
    let rollbackSucceeded = false;
    try {
      const isTokenX = dlmmPool.tokenX.publicKey.toBase58() === outputMint.toBase58();
      const inToken = isTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
      const outToken = isTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;
      const swapYtoX = (inToken.toBase58() === dlmmPool.tokenY.publicKey.toBase58());

      // Re-fetch what we actually still hold (Token-2022/hook visibility lag is common).
      let tokenBal = 0n;
      try {
        tokenBal = await getWalletTokenBalance(outputMint.toBase58());
      } catch {}
      if (tokenBal === 0n && actualTokenLamports > 0n) {
        tokenBal = actualTokenLamports;
      }
      if (tokenBal > 0n) {
        const inputAmountBN = new BN(tokenBal.toString());

        // Retry the quote + swap a few times with *fresh* binArrays each attempt.
        // "Insufficient liquidity in binArrays for swapQuote" is common on the reverse leg right after
        // the pre-swap (thin microcap depth + active bin moved by our own buy). A later monitor
        // recovery tick with new on-chain state often succeeds.
        const MAX_ROLLBACK_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ROLLBACK_ATTEMPTS && !rollbackSucceeded; attempt++) {
          try {
            // Fresh snapshot every attempt — critical for thin pools.
            const binArrays = await dlmmPool.getBinArrays();
            console.log(`${label} [direct-dlmm-rollback] attempt ${attempt}/${MAX_ROLLBACK_ATTEMPTS} — fetched ${binArrays.length} bin arrays (full list for swap)`);

            // Extremely loose for emergency unwind (100% slippage, minOut=0).
            const swapQuote = await dlmmPool.swapQuote(
              inputAmountBN,
              swapYtoX,
              new BN(10000),
              binArrays
            );
            const q = swapQuote as any;
            if (q.outAmount.isZero()) {
              throw new Error('Direct DLMM rollback quote gave 0 SOL output');
            }
            const quotedIn = q.inAmount ?? inputAmountBN;
            console.log(`${label} [direct-dlmm-rollback] quote: in=${quotedIn} out=${q.outAmount}`);
            const binArrayKeysForSwap = (q.binArraysPubkey && q.binArraysPubkey.length > 0)
              ? q.binArraysPubkey
              : binArrays.slice(0, 3).map((ba: any) => ba.publicKey);
            console.log(`${label} [direct-dlmm-rollback] calling swap with limited ${binArrayKeysForSwap.length} bin array pubkeys`);
            const swapTx = await dlmmPool.swap({
              inToken,
              binArraysPubkey: binArrayKeysForSwap,
              inAmount: inputAmountBN,
              lbPair: dlmmPool.pubkey,
              user: wallet.publicKey,
              minOutAmount: q.minOutAmount || new BN(0),
              outToken,
            });
            const rbSig = await sendLegacyTx(applyPriorityFee(swapTx, rollbackPriority), [wallet], `${label} direct-dlmm-rollback`);
            console.log(`${label} DIRECT DLMM rollback sell to SOL succeeded ✔ sig: ${rbSig}`);
            rollbackSucceeded = true;
          } catch (rbQuoteErr) {
            const msg = rbQuoteErr instanceof Error ? rbQuoteErr.message : String(rbQuoteErr);
            console.warn(`${label} [direct-dlmm-rollback] attempt ${attempt} failed: ${msg}`);
            if (attempt < MAX_ROLLBACK_ATTEMPTS) {
              await new Promise(r => setTimeout(r, 600));
            }
          }
        }

        if (!rollbackSucceeded) {
          console.warn(`${label} direct DLMM rollback quote/swap failed after ${MAX_ROLLBACK_ATTEMPTS} attempts (insufficient liquidity or other) — persisting stranded for monitor retry`);
        }
      }
    } catch (rbErr) {
      console.error(`${label} direct DLMM rollback sell ALSO failed — persisting stranded token marker for monitor recovery`, rbErr);
      try {
        const freshBal = await getWalletTokenBalance(outputMint.toBase58()).catch(() => actualTokenLamports);
        await persistStrandedTokenAfterFailedOpen(metrics, outputMint.toBase58(), freshBal || actualTokenLamports);
      } catch (persistErr) {
        console.error(`${label} failed to persist stranded marker:`, persistErr);
      }
    }

    if (!rollbackSucceeded) {
      // Ensure a stranded marker exists even if the outer try didn't reach the persist (e.g. early throws before balance check).
      try {
        const freshBal = await getWalletTokenBalance(outputMint.toBase58()).catch(() => actualTokenLamports);
        if (freshBal > 0n) {
          await persistStrandedTokenAfterFailedOpen(metrics, outputMint.toBase58(), freshBal);
        }
      } catch {}
    }
    // Reclaim on this failure path
    if (!successfullyOpened) {
      console.log(`${label} [TRACE] [FINALLY-CLOSE] !successfullyOpened — ATTEMPTING rent reclaim close (covers scaffolded or partial-create cases).`);
      if (positionScaffolded && positionKeypair && dlmmPool) {
        try {
          await persistStrandedPositionRent(
            positionKeypair.publicKey.toBase58(),
            dlmmPool.pubkey.toBase58(),
            minBinId,
            maxBinId,
            metrics.symbol
          );
        } catch (pErr) {
          console.warn(`${label} [TRACE] failed to persist stranded rent marker: ${pErr}`);
        }
      }
      if (positionKeypair && dlmmPool && wallet) {
        try {
          const closeOk = await tryCloseEmptyPosition(dlmmPool, positionKeypair.publicKey, wallet, minBinId, maxBinId, label, priorityFee);
          console.log(`${label} [TRACE] [FINALLY-CLOSE] tryCloseEmptyPosition call completed. success=${closeOk}`);
          if (!closeOk) {
            sendAlert({
              type: 'warning',
              message: `⚠️ Rent reclaim failed for ${positionKeypair.publicKey.toBase58()} — manual recovery needed (marker persisted for monitor)`,
            }).catch(() => {})
          }
        } catch (closeErr) {
          console.warn(`${label} [TRACE] [FINALLY-CLOSE-ERR] Finally close attempt threw (non-fatal).`);
          console.warn(`${label} finally close failed: ${closeErr}`);
        }
      }
    } else {
      console.log(`${label} [TRACE] [FINALLY-SUCCESS] success path — position fully opened, no rent reclaim needed.`);
      if (positionKeypair) {
        removePendingScaffold(positionKeypair?.publicKey?.toBase58?.());
      }
    }
    console.log(`${label} [TRACE] [FINALLY-EXIT] leaving finally block`);
    import('../../worker').then((m: any) => m.setOpenInProgress?.(false)).catch(() => {})
    return null;
  }
}

async function validateOpenEligibility(
  label: string,
  metrics: TokenMetrics,
  strategy: Strategy,
  solAmount: number,
  connection: Connection,
  wallet: Keypair
): Promise<
  | { ok: false }
  | {
      ok: true;
      limitState: any;
      poolPubkey: PublicKey;
    }
> {
  let limitState: any = await getOpenLpLimitState();

  const effectiveOpenCountForCap = limitState.effectiveOpenCount || 0;

  if (effectiveOpenCountForCap >= MAX_CONCURRENT_MARKET_LP_POSITIONS) {
    console.warn(`${label} concurrent position cap hit (${effectiveOpenCountForCap}/${MAX_CONCURRENT_MARKET_LP_POSITIONS})`);
    logWarn('open_position_skipped_concurrent_cap', {
      symbol: metrics.symbol,
      effectiveOpenCount: effectiveOpenCountForCap,
      max: MAX_CONCURRENT_MARKET_LP_POSITIONS,
    });
    return { ok: false };
  }

  // Note: the "cap ok" log is emitted once by the caller in openPosition after eligibility succeeds.
  // Removed duplicate here to reduce log noise.

  const maxTotalDeployed = MAX_MARKET_LP_SOL_DEPLOYED;
  const { totalDeployed, source: exposureSource } = await getTotalDeployedSolForCap(limitState);

  if (totalDeployed + solAmount > maxTotalDeployed) {
    console.warn(`${label} global exposure cap hit — ${totalDeployed.toFixed(3)} SOL deployed (${exposureSource})`);
    logWarn('open_position_skipped_exposure_cap', {
      symbol: metrics.symbol,
      totalDeployed,
      solAmount,
      maxTotalDeployed,
      source: exposureSource,
    });
    return { ok: false };
  }

  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const balanceSol = balanceLamports / 1e9;
  console.log(`${label} wallet balance: ${balanceSol.toFixed(4)} SOL`);

  const requiredSol = solAmount + METEORA_RENT_RESERVE_SOL + WALLET_MIN_SOL_RESERVE;

  if (balanceSol < requiredSol) {
    console.warn(`${label} insufficient balance — need ${requiredSol.toFixed(3)} SOL, have ${balanceSol.toFixed(4)}`);
    logWarn('legacy_bot_log', {
      level: 'warn',
      event: 'open_position_skipped_insufficient_balance',
      payload: {
        symbol: metrics.symbol,
        balanceSol,
        requiredSol,
        solAmount,
        meteoraRentReserveSol: METEORA_RENT_RESERVE_SOL,
        walletMinSolReserve: WALLET_MIN_SOL_RESERVE,
      },
    });
    return { ok: false };
  }

  let poolPubkey: PublicKey;
  try {
    poolPubkey = new PublicKey(metrics.poolAddress || '');
  } catch (e: any) {
    console.error(`${label} invalid poolAddress "${metrics.poolAddress}": ${e?.message || e}`);
    logWarn('legacy_bot_log', {
      level: 'error',
      event: 'open_position_skipped_bad_pool_address',
      payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress, error: e?.message || String(e) },
    });
    return { ok: false };
  }

  // Validate that this is a real on-chain DLMM pair
  try {
    const poolAccount = await connection.getAccountInfo(poolPubkey);
    const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
    if (!poolAccount || poolAccount.owner.toBase58() !== DLMM_PROGRAM_ID) {
      console.warn(`${label} pool ${metrics.poolAddress} not a valid DLMM lb pair (owner=${poolAccount?.owner.toBase58() ?? 'missing'}) — skipping`);
      logWarn('legacy_bot_log', {
        level: 'warn',
        event: 'open_position_skipped_non_dlmm_pool',
        payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress },
      });
      return { ok: false };
    }
  } catch (e: any) {
    console.warn(`${label} pool account lookup failed for ${metrics.poolAddress}: ${e?.message || e} — skipping open`);
    return { ok: false };
  }

  return { ok: true, limitState, poolPubkey };
}

/**
 * Direct SDK open for evil-panda Bid-Ask strategy (one-sided SOL + explicit direct DLMM pre-swap for the token leg).
 * Uses split transactions:
 *   Phase 1a: Top-level SystemProgram.createAccount (full space; no inner-CPI realloc cap).
 *   Phase 1b: initializePosition (via program.methods) on the pre-sized account owned by DLMM program.
 *   Phase 2: addLiquidityByStrategy (position is now initialized; only wallet signer needed).
 * This is required because the DLMM program's InitializePosition does a CPI realloc which is capped at
 * 10,240 bytes delta when performed from inside the program ("InvalidRealloc" / "Failed to reallocate account data").
 * Supports the full discrete evil-panda range (113-151+ bins) when the 0-new-bin-array gate passes.
 * Passes the value-matched *quoted* amount from pre-swap (not the huge on-chain delta) to keep position data reasonable.
 *
 * NOTE on sizing: `width = maxBinId - minBinId` (the value passed to initializePosition), but the on-chain
 * Position account must reserve space for `numBins = width + 1` bin entries. The previous size calc used
 * only `width`, which left the account one bin short and would still trigger a CPI realloc inside Phase 1b.
 */
async function openPositionDirect(
  metrics: TokenMetrics,
  strategy: Strategy,
  dlmmPool: any,
  poolPubkey: PublicKey,
  outputMint: PublicKey,
  _solAmount: number, // budgeted target passed from caller; we compute + persist effectiveDeployedSol from actual post-swap amounts instead
  minBinId: number,
  maxBinId: number,
  solIsTokenX: boolean,
  attemptLabel: string,
  priorityFee: number,
  DRY_RUN: boolean,
  positionKeypair: Keypair,
  remainingSolLamports: bigint = 0n,
  actualTokenLamports: bigint = 0n,
  skipScaffold = false // if early scaffold succeeded, force skip inner to avoid races/lag false-negatives on looksInitialized
): Promise<string | null> {
  const label = `${attemptLabel}[direct-primary]`

  console.log(`${label} [TRACE] [DIRECT-ENTER] openPositionDirect ENTERED. DRY_RUN=${DRY_RUN}`);
  console.log(`${label} [DRY-RUN GUARD] DRY_RUN param received: ${DRY_RUN}`)

  if (DRY_RUN) {
    console.log(`${label} [TRACE] [DIRECT-DRY] DRY RUN — skipping on-chain tx`);
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    return null
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    console.log(`${label} [TRACE] [DIRECT-START] fetching activeBin + computing totals...`);
    const activeBin = await dlmmPool.getActiveBin()

    const isTokenXSol = dlmmPool.tokenX.publicKey.toBase58() === NATIVE_MINT_STR
    const isTokenYSol = dlmmPool.tokenY.publicKey.toBase58() === NATIVE_MINT_STR

    // After direct Meteora DLMM pre-swap for the token leg (Bid-Ask one-sided).
    const totalX = isTokenXSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())
    const totalY = isTokenYSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)

    const numBins = maxBinId - minBinId + 1
    console.log(`${label} [TRACE] numBins=${numBins} for CU / sim decisions`)

    console.log(
      `${label} [TRACE] [DIRECT-TOTALS] add (scaffolding done pre-swap if needed) — totals from actual post-swap (range ${minBinId} → ${maxBinId}, strategyType=${strategyType})`
    );
    console.log(
      `${label} add (scaffolding done pre-swap if needed) — totals from actual post-swap (range ${minBinId} → ${maxBinId}, strategyType=${strategyType})`
    )
    console.log(`${label} [TRACE] [DIRECT-TOTALS] totals for add: totalX=${totalX.toString()} totalY=${totalY.toString()}`);
    console.log(`${label} totals for add: totalX=${totalX.toString()} totalY=${totalY.toString()}`)

    // Two-phase (split txs) to work around the 10KB *inner CPI* realloc limit for wide ranges (100+ bins).
    // The DLMM program's InitializePosition instruction performs a CPI to SystemProgram for account
    // realloc when it thinks the position needs more space. Solana caps *inner* (CPI) realloc deltas
    // at 10,240 bytes ("Account data size realloc limited to 10240 in inner instructions").
    //
    // Solution: two *separate* top-level transactions:
    //   Tx1: SystemProgram.createAccount (top-level → no CPI realloc limit; we allocate the *full*
    //        computed size for the position up front, paying rent for the worst-case position data).
    //   Tx2: raw initializePosition (now runs against an *already full-sized* account owned by the
    //        DLMM program. The program's init path should see sufficient space and skip its internal
    //        realloc CPI entirely).
    // Then Phase 2: addLiquidityByStrategy (identical to later manual adds on existing positions).
    //
    // This matches the original intent of the "raw program ix to pre-allocate" comment but actually
    // delivers a top-level allocation for the large data section.
    //
    // Smart scaffold inside direct (defensive): if early scaffold in caller already did it,
    // or a prior partial left a DLMM-owned account, skip to avoid "already in use".
    const DLMM_PROGRAM_ID = dlmmPool.program.programId.toBase58();
    const posInfo = await connection.getAccountInfo(positionKeypair.publicKey).catch(() => null);
    const isDlmmOwned = !!(posInfo && posInfo.owner.toBase58() === DLMM_PROGRAM_ID);
    const looksInitialized = !!(posInfo && posInfo.data && posInfo.data.length > 100);

    const lowerBinId = minBinId;
    const width = maxBinId - minBinId;
    const POSITION_HEADER = 256;
    const BYTES_PER_BIN = 128; // NOTE: must match current Meteora DLMM Position layout; re-validate if SDK upgrades (was source of realloc issues)
    const positionAccountSize = Math.max(POSITION_HEADER + numBins * BYTES_PER_BIN, 8192);
    const positionRentLamports = await connection.getMinimumBalanceForRentExemption(positionAccountSize);

    console.log(`${label} [TRACE] [DIRECT-SCAFFOLD-CHECK] isDlmmOwned=${isDlmmOwned} looksInitialized=${looksInitialized} skipScaffold=${skipScaffold}`);

    if (skipScaffold) {
      console.log(`${label} [TRACE] [DIRECT-SCAFFOLD-SKIP] skipScaffold=true from caller — skipping all inner scaffold`);
    }

    // Bundle create + init (same atomicity reason as early scaffold).
    // If early scaffold already ran successfully or skipScaffold, we skip inner entirely.
    const directScaffoldIxs: TransactionInstruction[] = [];

    if (!skipScaffold && !isDlmmOwned) {
      console.log(
        `${label} [TRACE] [DIRECT-CREATE] phase 1a: creating position account (space=${positionAccountSize} bytes, rent≈${(positionRentLamports / 1e9).toFixed(9)} SOL) for ${numBins} bins`
      );
      const createPositionAccountIx = SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: positionKeypair.publicKey,
        lamports: positionRentLamports,
        space: positionAccountSize,
        programId: dlmmPool.program.programId,
      });
      directScaffoldIxs.push(createPositionAccountIx);
    } else {
      console.log(`${label} [TRACE] [DIRECT-CREATE-SKIP] phase 1a: position already DLMM-owned — skipping create`);
      console.log(`${label} phase 1a: position already DLMM-owned — skipping create`);
    }

    if (!skipScaffold && !looksInitialized) {
      console.log(`${label} [TRACE] [DIRECT-INIT] phase 1b: initializePosition (lower=${lowerBinId}, width=${width})`);
      const initializePositionIx = await dlmmPool.program.methods
        .initializePosition(lowerBinId, width)
        .accounts(
          getInitializePositionAccounts(
            dlmmPool,
            wallet.publicKey,
            positionKeypair.publicKey,
            dlmmPool.pubkey
          )
        )
        .instruction();
      directScaffoldIxs.push(initializePositionIx);
    } else {
      console.log(`${label} [TRACE] [DIRECT-INIT-SKIP] phase 1b: position already initialized — skipping init`);
      console.log(`${label} phase 1b: position already initialized — skipping init`);
    }

    if (!skipScaffold && directScaffoldIxs.length > 0) {
      // Last-second defensive check in direct path too.
      const preBundleCheck = await connection.getAccountInfo(positionKeypair.publicKey).catch(() => null);
      if (preBundleCheck && preBundleCheck.lamports > 0) {
        console.warn(`${label} [TRACE] [DIRECT-SCAFFOLD-BUNDLE] key already exists — skipping (should have been caught by early scaffold or preflight).`);
      } else {
        const scaffoldTx = new Transaction();
        directScaffoldIxs.forEach((ix) => scaffoldTx.add(ix));
        const scaffoldPrep = applyPriorityFee(scaffoldTx, priorityFee);
        const what = (!isDlmmOwned && !looksInitialized) ? 'create+init (bundled)' : !isDlmmOwned ? 'create' : 'init';
        console.log(`${label} [TRACE] [DIRECT-SCAFFOLD-BUNDLE] sending ${what} (atomic to avoid orphan rent)...`);
        const scaffoldSig = await sendLegacyTx(scaffoldPrep, [wallet, positionKeypair], `${label} position-scaffold`);
        console.log(`${label} [TRACE] [DIRECT-SCAFFOLD-BUNDLE] ${what} COMPLETE ✔ sig: ${scaffoldSig}`);
        console.log(`${label} phase 1a/1b complete ✔ sig: ${scaffoldSig}`);
      }
    }

    // NEW: Post-swap add pre-sim using *actual* received amounts (addresses planned-vs-actual mismatch).
    // This is a read-only simulation after the irreversible pre-swap but before the real add.
    // If it fails with the actual amounts, abort the add (caller will handle rollback sell).
    console.log(`${label} [TRACE] [DIRECT-POST-SWAP-ADD-SIM] re-simulating addLiquidityByStrategy with actual post-swap amounts (numBins=${numBins})...`);
    let actualAddSimOk = false;
    try {
      const simAddResult: any = await dlmmPool.addLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalX,
        totalYAmount: totalY,
        strategy: {
          minBinId,
          maxBinId,
          strategyType,
        },
      });
      const simIxs = simAddResult?.instructions || (Array.isArray(simAddResult) ? simAddResult : []);
      const addCuForSim = numBins > 100 ? 2_000_000 : ADD_LIQUIDITY_FALLBACK_CU;
      if (simIxs.length > 0) {
        let cleaned = simIxs;
        if (numBins > 100) {
          cleaned = simIxs.filter((ix: any) => computeBudgetKind(ix) !== COMPUTE_BUDGET_SET_UNIT_LIMIT);
        }
        const simAddTx = new Transaction();
        cleaned.forEach((ix: any) => simAddTx.add(ix));
        const { blockhash: bh } = await connection.getLatestBlockhash('confirmed');
        simAddTx.recentBlockhash = bh;
        simAddTx.feePayer = wallet.publicKey;
        const simAddPrep = applyPriorityFee(simAddTx, priorityFee, addCuForSim);
        simAddPrep.recentBlockhash = bh;
        simAddPrep.feePayer = wallet.publicKey;
        actualAddSimOk = await simulateAndCheck(simAddPrep, `${label} [post-swap-add-sim]`);
      } else if (simAddResult) {
        const txs = Array.isArray(simAddResult) ? simAddResult : [simAddResult];
        for (const t of txs) {
          if (!t) continue;
          const { blockhash: bh } = await connection.getLatestBlockhash('confirmed');
          let txToUse = t;
          if (numBins > 100) {
            const filteredIxs = t.instructions.filter((ix: any) => computeBudgetKind(ix) !== COMPUTE_BUDGET_SET_UNIT_LIMIT);
            txToUse = new Transaction();
            filteredIxs.forEach((ix: any) => txToUse.add(ix));
          }
          txToUse.recentBlockhash = bh;
          txToUse.feePayer = wallet.publicKey;
          const prepared = applyPriorityFee(txToUse, priorityFee, addCuForSim);
          prepared.recentBlockhash = bh;
          prepared.feePayer = wallet.publicKey;
          actualAddSimOk = await simulateAndCheck(prepared, `${label} [post-swap-add-sim-tx]`);
          if (!actualAddSimOk) break;
        }
      } else {
        console.warn(`${label} [TRACE] [DIRECT-POST-SWAP-ADD-SIM-FAIL] no ixs from SDK for actual sim`);
        actualAddSimOk = false;
      }
    } catch (e) {
      console.error(`${label} [TRACE] [DIRECT-POST-SWAP-ADD-SIM-THROW] ${e}`);
      actualAddSimOk = false;
    }
    console.log(`${label} [TRACE] [DIRECT-POST-SWAP-ADD-SIM-RESULT] actualAddSimOk=${actualAddSimOk}`);
    if (!actualAddSimOk) {
      console.error(`${label} post-swap add pre-sim with ACTUAL amounts failed — returning null so caller rolls back instead of adding.`);
      return null;
    }

    // Final belt-and-suspenders verification right before actually adding liquidity.
    console.log(`${label} [TRACE] [DIRECT-VERIFY] final assertNoNewBinArraysForRange before funding...`);
    await assertNoNewBinArraysForRange(dlmmPool, minBinId, maxBinId, label);
    console.log(`${label} [TRACE] [DIRECT-VERIFY] ✅ bin arrays still verified zero-new before add.`);

    // Phase 2: addLiquidityByStrategy (position is now properly initialized).
    console.log(`${label} [TRACE] [DIRECT-ADD] In openPositionDirect: about to call addLiquidityByStrategy (the actual funding step).`);
    console.log(`${label} [TRACE] In openPositionDirect: about to call addLiquidityByStrategy (the actual funding step).`);
    console.log(`${label} phase 2: addLiquidityByStrategy`);
    const addResult: any = await dlmmPool.addLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: totalX,
      totalYAmount: totalY,
      strategy: {
        minBinId,
        maxBinId,
        strategyType,
      },
    });

    const ixs = addResult?.instructions || (Array.isArray(addResult) ? addResult : []);
    const addCu = numBins > 100 ? 2_000_000 : ADD_LIQUIDITY_FALLBACK_CU;
    let liqSig = '';
    console.log(`${label} [TRACE] [DIRECT-ADD-SEND] addResult has ${ixs.length} instructions (or full tx objects), CU floor=${addCu}`);
    // To ensure our high CU for wide ranges takes effect, strip any existing setComputeUnitLimit from the SDK result
    const cleanedIxs = numBins > 100 
      ? ixs.filter((ix: any) => computeBudgetKind(ix) !== COMPUTE_BUDGET_SET_UNIT_LIMIT)
      : ixs;
    if (cleanedIxs.length > 0) {
      const tx = new Transaction();
      cleanedIxs.forEach((ix: any) => tx.add(ix));
      const preparedTx = applyPriorityFee(tx, priorityFee, addCu);
      console.log(`${label} [TRACE] [DIRECT-ADD-SEND] sending add-liquidity tx...`);
      const sig = await sendLegacyTx(preparedTx, [wallet], `${label} add-liquidity`);
      console.log(`${label} [TRACE] [DIRECT-ADD-OK] add liquidity confirmed ✔ sig: ${sig}`);
      console.log(`${label} ✓ direct SDK add liquidity confirmed. Sig: ${sig}`);
      liqSig = sig;
    } else {
      // SDK returned full Transaction(s) instead of {instructions}
      const txsToSend = Array.isArray(addResult) ? addResult : [addResult];
      for (const t of txsToSend) {
        if (!t) continue;
        let txToUse = t;
        if (numBins > 100) {
          const filteredIxs = t.instructions.filter((ix: any) => computeBudgetKind(ix) !== COMPUTE_BUDGET_SET_UNIT_LIMIT);
          txToUse = new Transaction();
          filteredIxs.forEach((ix: any) => txToUse.add(ix));
        }
        const preparedTx = applyPriorityFee(txToUse, priorityFee, addCu);
        console.log(`${label} [TRACE] [DIRECT-ADD-SEND] sending one of the full txs from SDK...`);
        const sig = await sendLegacyTx(preparedTx, [wallet], `${label} add-liquidity`);
        console.log(`${label} [TRACE] [DIRECT-ADD-OK] add liquidity confirmed ✔ sig: ${sig}`);
        console.log(`${label} ✓ direct SDK add liquidity confirmed. Sig: ${sig}`);
        liqSig = sig;
      }
    }

    // Fetch position data for persistence (best effort)
    let tokenAmountDeposited = 0
    try {
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
      const userPos = userPositions.find(
        (p: any) => p.publicKey.toBase58() === positionKeypair.publicKey.toBase58()
      )
      if (userPos?.positionData) {
        const pd = userPos.positionData
        const rawAmount = isTokenXSol ? pd.totalYAmount : pd.totalXAmount
        tokenAmountDeposited = typeof rawAmount === 'object'
          ? (rawAmount as BN).toNumber() / 1e6
          : Number(rawAmount) / 1e6
      }
    } catch (inspectErr) {
      console.warn(`${label} Could not fetch final position data for logging:`, inspectErr)
    }

    const openSig = liqSig

    // Compute actual capital deployed using the post-swap received amounts + entry price.
    // This replaces the budgeted solAmount so that persisted sol_deposited, exposure caps,
    // and records reflect reality (slippage, actual token received) rather than the pre-swap target.
    const entryPriceSol = getDecimalAdjustedPrice(dlmmPool, activeBin);
    const tokenDecimals = isTokenXSol
      ? (dlmmPool.tokenY?.decimals ?? 6)
      : (dlmmPool.tokenX?.decimals ?? 6);
    const actualTokenWhole = Number(actualTokenLamports) / Math.pow(10, tokenDecimals);
    const actualTokenValueSol = actualTokenWhole * entryPriceSol;
    const effectiveDeployedSol = (Number(remainingSolLamports) / 1e9) + actualTokenValueSol;

    const positionId = await persistPosition(
      metrics,
      strategy,
      openSig,
      metrics.priceUsd ?? 0,
      entryPriceSol,
      effectiveDeployedSol,
      positionKeypair.publicKey.toBase58(),
      tokenAmountDeposited,
      DRY_RUN
    )

    await sendOpenAlert(metrics, strategy, positionId, effectiveDeployedSol, entryPriceSol)

    console.log(`${label} [TRACE] [DIRECT-SUCCESS] openPositionDirect completed successfully — persist and alert done.`);
    console.log(`${label} [TRACE] [DIRECT-SUCCESS] successfullyOpened should be set by caller now.`);
    console.log(`${label} [TRACE] openPositionDirect completed successfully — persist and alert done.`);
    console.log(`${label} position opened successfully via direct SDK primary path ✔`)
    return positionId

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`${label} [TRACE] [DIRECT-THROW] openPositionDirect threw — outer finally (in openPosition) will attempt close if scaffolded.`);
    console.log(`${label} [TRACE] openPositionDirect threw — this will be caught by outer finally for close.`);
    console.error(`${label} failed:`, message)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    logError('open_position_direct_primary_failed', {
      symbol: metrics.symbol,
      strategy: strategy.id,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    return null
  }
}

/**
 * Attempt to close an empty (or zero-liquidity) position to reclaim the rent
 * paid during createAccount. Called on failure paths after scaffolding.
 * This is the main defense against orphaned position account rent losses.
 */
/**
 * Attempt to close an empty (or zero-liquidity) position to reclaim the rent
 * paid during createAccount. Called on failure paths after scaffolding.
 * This is the main defense against orphaned position account rent losses.
 *
 * Returns true if a close succeeded (account likely gone or rent reclaimed).
 * Returns false if all attempts exhausted (may need manual or monitor retry).
 * Errors are caught internally; callers should check return or on-chain state.
 */
async function tryCloseEmptyPosition(
  dlmmPool: any,
  positionPubKey: PublicKey,
  wallet: any,
  minBinId?: number,
  maxBinId?: number,
  label: string = '[recover]',
  priorityFee: number = 50_000
): Promise<boolean> {
  const hasRange = typeof minBinId === 'number' && typeof maxBinId === 'number';
  console.log(`${label} [TRACE] [CLOSE-ENTRY] Entering tryCloseEmptyPosition for key=${positionPubKey.toBase58().slice(0,8)} ${hasRange ? `(range ${minBinId}→${maxBinId})` : '(no range - using closePosition only)'}. This is the rent-reclaim attempt.`);
  console.log(`${label} [TRACE] [CLOSE-ENTRY] Using priority ${Math.max(priorityFee, 50_000)} for close.`);

  // Use higher priority for recovery closes to increase chance of landing
  const closePriority = Math.max(priorityFee, 50_000);

  // Snapshot on-chain state before attempting close (best effort)
  try {
    const posInfo = await getConnection().getAccountInfo(positionPubKey).catch(() => null);
    console.log(`${label} [TRACE] [CLOSE-POS-INFO] on-chain account exists=${!!posInfo} owner=${posInfo?.owner?.toBase58?.().slice(0,8) ?? 'n/a'} dataLen=${posInfo?.data?.length ?? 0}`);
  } catch (e) {
    console.log(`${label} [TRACE] [CLOSE-POS-INFO] could not fetch pos info: ${e}`);
  }

  // If we have a valid range, try the standard remove + close first (for properly initialized empty positions)
  // But skip removeLiquidity if the position was aborted before addLiquidity (zero liquidity case).
  if (hasRange) {
    let hasLiquidity = false;
    try {
      const userPositions = (await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey))?.userPositions || [];
      const posData = userPositions.find((p: any) => p.publicKey.equals(positionPubKey))?.positionData;
      hasLiquidity = posData && (Number(posData.totalXAmount || 0) + Number(posData.totalYAmount || 0) > 0);
    } catch {}
    if (!hasLiquidity) {
      console.log(`${label} [TRACE] [CLOSE-SKIP-REMOVE] No liquidity on position (aborted before add) — skipping removeLiquidity, using closePosition fallback directly.`);
    } else {
      try {
        console.log(`${label} [TRACE] [CLOSE-REMOVE] Attempting removeLiquidity + shouldClaimAndClose (100% bps) to close empty pos...`);
        const removeTx = await dlmmPool.removeLiquidity({
          position: positionPubKey,
          user: wallet.publicKey,
          fromBinId: minBinId,
          toBinId: maxBinId,
          bps: new BN(10000),
          shouldClaimAndClose: true,
        });
        console.log(`${label} [TRACE] [CLOSE-REMOVE] removeLiquidity call returned ${Array.isArray(removeTx) ? removeTx.length : 1} tx(s)`);
        for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
          const sig = await sendLegacyTx(applyPriorityFee(tx, closePriority), [wallet], `${label} close-empty-for-rent`);
          console.log(`${label} [TRACE] [CLOSE-REMOVE-SUCCESS] removeLiquidity close succeeded.`);
          console.log(`${label} closed empty position to reclaim rent ✔ sig: ${sig}`);
          return true; // success
        }
      } catch (closeErr) {
        const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        console.log(`${label} [TRACE] [CLOSE-REMOVE-THROW] removeLiquidity threw: ${msg}`);
        if (msg.includes('liquidity') || msg.includes('Liquidity') || msg.includes('zero')) {
          console.log(`${label} [TRACE] [CLOSE-REMOVE-ZERO] removeLiquidity rejected for zero-liquidity (EXPECTED for empty post-abort case); trying direct close fallback...`);
        } else {
          console.warn(`${label} [TRACE] [CLOSE-REMOVE-OTHER] removeLiquidity close failed: ${msg}`);
          console.warn(`${label} removeLiquidity close failed: ${msg}`);
        }
      }
    }
  } else {
    console.log(`${label} [TRACE] [CLOSE-SKIP-REMOVE] No bin range provided (uninitialized/ghost account) — skipping removeLiquidity, going straight to closePosition fallback.`);
  }

  // Fallback (or primary for ghost/uninit accounts): use closePosition directly. This works for many empty or partially-created accounts without needing bin range.
  try {
    if (typeof dlmmPool.closePosition === 'function') {
      console.log(`${label} [TRACE] [CLOSE-FALLBACK] Attempting dlmmPool.closePosition() (primary for uninit/stranded accounts)...`);
      const closeTx = await dlmmPool.closePosition(positionPubKey, wallet.publicKey);
      const txs = Array.isArray(closeTx) ? closeTx : [closeTx];
      for (const tx of txs) {
        const sig = await sendLegacyTx(applyPriorityFee(tx, closePriority), [wallet], `${label} close-empty-fallback`);
        console.log(`${label} [TRACE] [CLOSE-FALLBACK-SUCCESS] closePosition succeeded.`);
        console.log(`${label} closed empty/stranded position via direct close ✔ sig: ${sig}`);
      }
      return true;
    } else {
      console.log(`${label} [TRACE] [CLOSE-FALLBACK-NOOP] dlmmPool has no closePosition() method.`);
    }
  } catch (fallbackErr) {
    console.log(`${label} [TRACE] [CLOSE-FALLBACK-THROW] closePosition fallback threw: ${fallbackErr}`);
    console.warn(`${label} [TRACE] direct closePosition also failed: ${fallbackErr}`);
    console.warn(`${label} direct closePosition also failed: ${fallbackErr}`);
  }

  console.warn(`${label} [TRACE] [CLOSE-EXHAUSTED] All rent-reclaim attempts exhausted.`);
  console.warn(`${label} [TRACE] All close attempts failed — position rent may be locked (manual recovery needed via key ${positionPubKey.toBase58()})`);
  console.warn(`${label} All close attempts failed — position rent may be locked (manual recovery needed via key ${positionPubKey.toBase58()})`);
  return false;
}

// Also export for potential use in monitor or recovery if needed
export { tryCloseEmptyPosition };



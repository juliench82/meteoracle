/**
 * bot/executor/open.ts
 *
 * Position opening for Meteora DLMM (evil-panda: Bid-Ask, explicit pre-swap for
 * the token leg so we can do true one-sided-SOL economics on a Bid-Ask shape).
 *
 * Core workflow (per design):
 *   X SOL budget → calculate TOKEN amount needed for value match → target full
 *   desired -50% / +100% range → hard gate: must cost zero new bin arrays →
 *   SWAP for the TOKEN leg (using actual received amount after slippage) →
 *   openPositionDirect with (remaining SOL + actual TOKEN).
 *
 * The range is the *closest discrete bins* Meteora will actually give you.
 * We never enforce literal -50.00% / +100.00%. We use Math.round() on the
 * percentage-to-bin math and only proceed if the resulting range has all its
 * bin arrays already on-chain (the free-range / zero-rent gate).
 *
 * No artificial width cap (the old 70-bin / Zap limits are gone).
 * The only limit is economic: if the desired range would require new bin arrays,
 * we skip cleanly and wait for other LPs to populate them.
 *
 * Position account sizing note: We correctly compute numBins = (maxBinId - minBinId) + 1
 * when pre-allocating via top-level createAccount so the subsequent initializePosition
 * does not trigger an inner-CPI realloc (which is capped at 10,240 bytes).
 *
 * CRITICAL SUCCESS CRITERIA (user directive):
 *   - No ZAP code path is used for opening. Entire bot purpose depends on reliably
 *     opening the full desired discrete range (-50% down / +100% up via round() bin math)
 *     using direct DLMM SDK + pre-swap (Meteora native) for value match + zero new bin array gate.
 *   - If we cannot open such positions the bot has no purpose at all.
 *   - Pre-swap for the token leg (and post-close sells) now uses direct Meteora DLMM swaps
 *     via the SDK (swapQuote + swap on the target pool). Jupiter completely removed from
 *     opening pre-swaps, closing sells, and rollback. See swapSolToTokenDirectOnDlmm and
 *     the direct sell logic in close.ts. Detailed [direct-dlmm] logs for debugging.
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
import { STRATEGIES } from '@/strategies'


import {
  simulateAndCheck,
  sendLegacyTx,
  applyPriorityFee,
  addPriorityFeeAndPreserveComputeLimit,
} from '@/lib/solana-tx'

import {
  persistPosition,
  sendOpenAlert,
  findExistingActivePosition,
  persistStrandedTokenAfterFailedOpen,
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

  const botState = await getBotState()
  const DRY_RUN = ENV_DRY_RUN_FORCED || botState.dry_run

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
    const existing = await findExistingActivePosition(metrics.address)
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
  const wallet = getWallet()

  try {
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

    const DLMM = await getDLMM()
    const dlmmPool = await DLMM.create(connection, poolPubkey)
    const activeBin = await dlmmPool.getActiveBin()
    const initialActiveBinId = activeBin.binId

    const entryPriceSol = getDecimalAdjustedPrice(dlmmPool, activeBin)
    console.log(`${label} entry price: ${entryPriceSol.toFixed(9)} SOL/token (bin ${initialActiveBinId})`)

    const binStep = dlmmPool.lbPair.binStep
    const mintX = dlmmPool.tokenX.publicKey
    const mintY = dlmmPool.tokenY.publicKey
    const solIsTokenX = mintX.toBase58() === NATIVE_MINT_STR
    const solIsTokenY = mintY.toBase58() === NATIVE_MINT_STR

    const outputMint = solIsTokenX ? mintY : mintX
    const isToken2022 = (await getTokenProgramId(outputMint)).toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()

    console.log(`${label} Token program resolved for output mint ${outputMint.toBase58().slice(0, 8)} → ${isToken2022 ? 'Token-2022' : 'Legacy Token'}`)

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
    const minBinId = feasibility.minBinId;
    const maxBinId = feasibility.maxBinId;
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

    // NOTE on range:
    // We deliberately do *not* hard-cap the number of bins here.
    // The whole point of the current design (vs the old artificial 70-bin / Zap limits)
    // is to allow full desired evil-panda ranges (-50% / +100% on binStep=100 → often 150+ bins)
    // as long as the required bin arrays already exist on-chain (the gate above).
    //
    // Meteora never gives you exactly the requested % because of discrete bin boundaries.
    // The Math.round() + the bin-array existence gate (enforced both here and early in deep-checker for evil-panda)
    // is the "subtle" part: we ask for the closest achievable discrete range and only open if it costs zero rent.

    // ATA pre-creation for the token side(s) (uses getTokenProgramId per mint so Token-2022 sides get the correct program).
    // Done before the direct SDK path.
    const ataIxs: TransactionInstruction[] = []
    for (const [lbl, mint] of [['X', mintX], ['Y', mintY]] as [string, PublicKey][]) {
      if (mint.toBase58() === NATIVE_MINT_STR) {
        console.log(`${label} token ${lbl} is native SOL — skipping ATA`)
        continue
      }
      const tokenProgramId = await getTokenProgramId(mint)
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID)
      if (!(await connection.getAccountInfo(ata))) {
        console.log(`${label} creating ATA for token ${lbl} (${mint.toBase58().slice(0, 8)}…)`)
        ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, ata, wallet.publicKey, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
        ))
      }
    }
    if (ataIxs.length > 0) {
      const ataTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ...ataIxs
      )
      const ataSig = await sendLegacyTx(ataTx, [wallet], label)
      console.log(`${label} ATA(s) created ✔ sig: ${ataSig}`)
    }

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

    const priorityFee = await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()])
    console.log(`${label} priority fee: ${priorityFee} microlamports`)

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

    let actualTokenLamports = 0n
    if (solToSwapLamports > 0n) {
      // Prefer direct swap on the DLMM pool itself using Meteora SDK (native swap, no Jupiter).
      // Meteora UI exposes swap on DLMM pools; the SDK has swapQuote + swap for exactly this.
      // Since the pool already passed the full evil-panda range gate (bin arrays exist and populated),
      // direct swap on this pool is the natural way to acquire the token leg for the Bid-Ask.
      // This completely bypasses Jupiter 0x177e issues for these specific pools.
      console.log(`${label} attempting direct DLMM swap for token leg (Meteora SDK native, bypassing Jupiter)`);
      try {
        actualTokenLamports = await swapSolToTokenDirectOnDlmm(
          dlmmPool,
          solToSwapLamports,
          outputMint,
          solIsTokenX,
          label
        );
        if (actualTokenLamports > 0n) {
          console.log(`${label} direct DLMM swap succeeded: received ${actualTokenLamports} token lamports`);
        }
      } catch (directErr) {
        console.error(`${label} direct DLMM swap for token leg FAILED: ${directErr instanceof Error ? directErr.message : directErr}`);
        console.error(`${label} (Jupiter completely ditched per user request — no fallback; skipping pool)`);
        return null;
      }
    }

    if (solToSwapLamports > 0n && actualTokenLamports === 0n) {
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
      console.log(`${label} swap done: received ${actualTokenLamports} token lamports`);
    }

    const positionKeypair = new Keypair()

    // === DIRECT (using remaining SOL + actual received token from any pre-swap) ===
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
      actualTokenLamports
    );
    if (directResult) {
      console.log(`${label} position opened successfully via direct SDK ✔`);
      return directResult;
    }

    // Rollback path: position creation failed after successful direct DLMM pre-swap.
    // Use direct DLMM sell (Meteora native) to return tokens to SOL. (Jupiter fully ditched.)
    // IMPORTANT: re-query the *current* token balance right now (the pre-swap "actualTokenLamports"
    // may be stale/huge/wrong due to prior bugs or the failed open attempt). Use looser slippage
    // for the emergency sell so we don't strand on 0x1773 like before.
    console.error(`${label} position open failed after successful pre-swap — attempting DIRECT DLMM rollback sell to SOL`);
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
            const binArrayKeysForSwap = binArrays.map((ba: any) => ba.publicKey);
            console.log(`${label} [direct-dlmm-rollback] calling swap with FULL ${binArrayKeysForSwap.length} bin array pubkeys`);
            const swapTx = await dlmmPool.swap({
              inToken,
              binArraysPubkey: binArrayKeysForSwap,
              inAmount: inputAmountBN,
              lbPair: dlmmPool.pubkey,
              user: wallet.publicKey,
              minOutAmount: new BN(0),
              outToken,
            });
            const rbSig = await sendLegacyTx(applyPriorityFee(swapTx, 100000), [wallet], `${label} direct-dlmm-rollback`);
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
    return null;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    logError('open_position_failed', {
      symbol: metrics.symbol,
      strategy: strategy.id,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    return null
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
 * Uses two-phase *split transactions*:
 *   Phase 1a: Top-level SystemProgram.createAccount (full space for the position; no inner-CPI realloc cap).
 *   Phase 1b: raw initializePosition (runs against the pre-sized account → program skips its realloc CPI).
 *   Phase 2: addLiquidityByStrategy (range already initialized + sized in phase 1; same call used for later adds).
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
  actualTokenLamports: bigint = 0n
): Promise<string | null> {
  const label = `${attemptLabel}[direct-primary]`

  console.log(`${label} [DRY-RUN GUARD] DRY_RUN param received: ${DRY_RUN}`)

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    return null
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const activeBin = await dlmmPool.getActiveBin()

    const isTokenXSol = dlmmPool.tokenX.publicKey.toBase58() === NATIVE_MINT_STR
    const isTokenYSol = dlmmPool.tokenY.publicKey.toBase58() === NATIVE_MINT_STR

    // After direct Meteora DLMM pre-swap for the token leg (Bid-Ask one-sided).
    const totalX = isTokenXSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())
    const totalY = isTokenYSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)

    console.log(
      `${label} using TWO-PHASE direct (System createAccount + initializePosition + addLiquidityByStrategy) ` +
      `(after direct DLMM pre-swap, range ${minBinId} → ${maxBinId}, strategyType=${strategyType})`
    )
    console.log(`${label} totals for SDK call: totalX=${totalX.toString()} totalY=${totalY.toString()}`)
    console.log(`${label} using quoted amounts for position totals (value-matched from pre-swap delta/quotedOut, NOT the raw on-chain wallet delta)`)

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
    // Important: `width` (max - min) is what the SDK's initializePosition expects, but the account
    // must be sized for `numBins = width + 1` bin records. Off-by-one here was the remaining cause
    // of realloc attempts even after the split-tx change.
    const lowerBinId = minBinId;
    const width = maxBinId - minBinId;   // delta passed to the SDK's initializePosition(lowerBinId, width)
    const numBins = width + 1;           // actual number of bins the position will cover (fencepost)
    // Conservative per-bin data size (covers liquidity shares + fees + extra for Token-2022 variants).
    // 113-151 bin evil-panda ranges on binStep 100-125 commonly land in the 12-20KB range.
    const POSITION_HEADER = 256;
    const BYTES_PER_BIN = 128;
    const positionAccountSize = Math.max(POSITION_HEADER + numBins * BYTES_PER_BIN, 8192);
    const positionRentLamports = await connection.getMinimumBalanceForRentExemption(positionAccountSize);

    console.log(
      `${label} phase 1a: creating position account (space=${positionAccountSize} bytes, rent≈${(positionRentLamports / 1e9).toFixed(6)} SOL) for ${numBins} bins via top-level System createAccount`
    );

    const createPositionAccountIx = SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: positionKeypair.publicKey,
      lamports: positionRentLamports,
      space: positionAccountSize,
      programId: dlmmPool.program.programId, // transfer ownership to DLMM program immediately
    });

    const createTx = new Transaction().add(createPositionAccountIx);
    const createPrep = applyPriorityFee(createTx, priorityFee);
    const createSig = await sendLegacyTx(createPrep, [wallet, positionKeypair], `${label} create-pos-account`);
    console.log(`${label} phase 1a complete ✔ sig: ${createSig} (account exists full-sized; now initializing)`);

    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      dlmmPool.program.programId
    );
    const initPositionIx = await dlmmPool.program.methods
      .initializePosition(lowerBinId, width)
      .accounts({
        payer: wallet.publicKey,
        position: positionKeypair.publicKey,
        owner: wallet.publicKey,
        lbPair: dlmmPool.pubkey,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        eventAuthority,
        program: dlmmPool.program.programId,
      })
      .instruction();

    console.log(`${label} phase 1b: initializePosition(lowerBinId=${lowerBinId}, width=${width}) on pre-sized account for ${numBins} bins (no realloc expected in this tx)`);
    let initSig = '';
    try {
      const initTx = new Transaction().add(initPositionIx);
      const initPrep = applyPriorityFee(initTx, priorityFee);
      initSig = await sendLegacyTx(initPrep, [wallet, positionKeypair], `${label} init-position`);
      console.log(`${label} phase 1b complete: position initialized ✔ sig: ${initSig} (now calling addLiquidityByStrategy)`);
    } catch (initErr: any) {
      const msg = initErr instanceof Error ? initErr.message : String(initErr);
      if (msg.includes('already in use') || msg.includes('Allocate') || msg.includes('custom program error: 0x0')) {
        console.warn(`${label} phase 1b init failed with allocate/already-in-use (expected after top-level pre-create for some DLMM program versions) — proceeding directly to addLiquidityByStrategy on the pre-sized account`);
      } else {
        throw initErr;
      }
    }

    // Phase 2: add liquidity (position + range already initialized + sized in phase 1, or pre-sized account).
    // Use the same addLiquidityByStrategy pattern the rest of the bot uses for existing positions.
    // If we skipped the explicit init above, the add may perform the necessary data initialization on the pre-created account.
    console.log(`${label} phase 2: addLiquidityByStrategy (range pre-initialized in phase 1 or pre-sized account, using quoted totals)`);
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
    let liqSig = '';
    if (ixs.length > 0) {
      const tx = new Transaction();
      ixs.forEach((ix: any) => tx.add(ix));
      const preparedTx = applyPriorityFee(tx, priorityFee);
      const sig = await sendLegacyTx(preparedTx, [wallet, positionKeypair], `${label} add-liquidity`);
      console.log(`${label} ✓ direct SDK add liquidity confirmed. Sig: ${sig}`);
      liqSig = sig;
    } else {
      // Some SDK responses may already be transaction(s); fall back to previous handling
      const txsToSend = Array.isArray(addResult) ? addResult : [addResult];
      for (const t of txsToSend) {
        if (!t) continue;
        const preparedTx = applyPriorityFee(t, priorityFee);
        const sig = await sendLegacyTx(preparedTx, [wallet, positionKeypair], `${label} add-liquidity`);
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

    console.log(`${label} position opened successfully via direct SDK primary path ✔`)
    return positionId

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
 * Direct swap on the DLMM pool itself using Meteora SDK (native swap, no aggregator).
 * This acquires the token leg for the Bid-Ask pre-swap directly against the target pool's liquidity.
 * Since the pool passed the full evil-panda range gate, the necessary bin arrays exist.
 * Uses the same dlmmPool already loaded for range/price calculation.
 */
async function swapSolToTokenDirectOnDlmm(
  dlmmPool: any,
  solLamports: bigint,
  outputMint: PublicKey,
  solIsTokenX: boolean,
  label: string
): Promise<bigint> {
  const connection = getConnection();
  const wallet = getWallet();

  const inToken = solIsTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
  const outToken = solIsTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;

  const activeBinAtSwap = await dlmmPool.getActiveBin();
  console.log(`${label} [direct-dlmm] swapping ${solLamports} lamports SOL → token on DLMM pool (activeBin=${activeBinAtSwap.binId}, in=${inToken.toBase58().slice(0,8)}, out=${outToken.toBase58().slice(0,8)})`);

  // Pre-swap balance for debug (also captured for delta calc below)
  let preBalForDelta = 0n;
  try {
    preBalForDelta = await getWalletTokenBalance(outToken.toBase58());
    console.log(`${label} [direct-dlmm] pre-swap ${outToken.toBase58().slice(0,8)} balance: ${preBalForDelta}`);
  } catch {}

  const binArrays = await dlmmPool.getBinArrays();
  console.log(`${label} [direct-dlmm] fetched ${binArrays.length} bin arrays (for quote + swap on this pool; will pass FULL list to swap builder to satisfy Swap2 bin_array keys)`);

  // swapYtoX: true if swapping Y (the non-SOL if solIsTokenX false?) into X.
  // If solIsTokenX, SOL is X, we are swapping X (SOL) for Y (token) → swapYtoX = false
  // If !solIsTokenX, SOL is Y, swapping Y (SOL) for X (token) → swapYtoX = true
  const swapYtoX = !solIsTokenX;

  const inputAmountBN = new BN(solLamports.toString());
  const swapQuote = await dlmmPool.swapQuote(
    inputAmountBN,
    swapYtoX,
    new BN(1), // will use the quote's minOut
    binArrays
  );
  const q = swapQuote as any;

  if (q.outAmount.isZero()) {
    throw new Error('Direct DLMM swap quote gave zero output (insufficient liquidity on that side)');
  }

  const quotedIn = q.inAmount ?? inputAmountBN;
  console.log(`${label} [direct-dlmm] quote: in=${quotedIn} out=${q.outAmount} fee=${q.fee}`);

  const binArrayKeysForSwap = binArrays.map((ba: any) => ba.publicKey);
  console.log(`${label} [direct-dlmm] calling swap with FULL ${binArrayKeysForSwap.length} bin array pubkeys (not q.binArraysPubkey) to prevent Anchor AccountNotEnoughKeys 3005 on bin_array during internal CU sim`);
  const swapTx = await dlmmPool.swap({
    inToken,
    binArraysPubkey: binArrayKeysForSwap,
    inAmount: inputAmountBN,  // use the exact input we quoted for (more reliable than q.inAmount across SDK responses)
    lbPair: dlmmPool.pubkey,
    user: wallet.publicKey,
    minOutAmount: q.minOutAmount,
    outToken,
  });

  // The SDK returns a Transaction (legacy). Apply priority fee and send.
  const priorityFee = await getPriorityFee([dlmmPool.pubkey.toBase58(), wallet.publicKey.toBase58()]);
  const preparedTx = applyPriorityFee(swapTx, priorityFee);

  const sig = await sendLegacyTx(preparedTx, [wallet], `${label} direct-dlmm-swap`);

  console.log(`${label} [direct-dlmm] swap confirmed ✔ sig: ${sig}`);

  // Read actual received (delta) + post balance for debug.
  // Token-2022 + hooks can have visibility lag. We always prefer the SDK's quotedOut for the
  // amount passed to the position initializer (this is the "value matched" leg from the split
  // calculation at the entry price). The on-chain delta can be much larger (good execution or
  // raw unit scale on cheap tokens); we log it for visibility but use the quoted for totals
  // so the 151-bin position account stays a reasonable size for the DLMM initializer.
  let postBal = 0n;
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 600));
      postBal = await getWalletTokenBalance(outToken.toBase58());
      if (postBal > 0n) break;
    }
  } catch {}
  const delta = postBal > preBalForDelta ? postBal - preBalForDelta : postBal;

  const quotedOut = q?.outAmount && !q.outAmount.isZero() ? BigInt(q.outAmount.toString()) : 0n;
  const amountForPosition = quotedOut > 0n ? quotedOut : delta;

  try {
    console.log(`${label} [direct-dlmm] post-swap ${outToken.toBase58().slice(0,8)} balance: ${postBal} (delta=${delta}, usedForLp=${amountForPosition}, quotedOut=${quotedOut || 'n/a'})`);
  } catch {}
  return amountForPosition;
}

/**
 * Centralized check for whether a pool currently supports the full desired evil-panda
 * Bid-Ask range (-50% / +100% by default, via env) with *zero* new bin arrays.
 *
 * This is the hard economic gate for the strategy:
 *   - Uses Math.round() for discrete bin math (Meteora never gives literal %).
 *   - Queries getBinArraysRequiredByPositionRange + on-chain account existence.
 *   - Returns detailed info so callers (open.ts and deep-checker.ts) can log precisely
 *     and early-reject in the scanner (so "deep survivors" and ranked list only include
 *     pools where we can actually open the full range the user requires).
 *
 * If this returns feasible=false, we skip cleanly — no non-refundable rent is paid,
 * and we wait for other LPs to populate the arrays (per design).
 *
 * Returned fields include the exact `fullBinsDown`/`fullBinsUp` (from Math.round) so callers
 * can compute the Bid-Ask split without duplicating the discrete math.
 *
 * Callers (currently open.ts) may implement active-bin-drift retry: if the active bin moved
 * between an earlier fetch and this check, a short re-check can be performed before deciding
 * to skip.
 */
export async function checkFullEvilPandaRangeFeasibility(
  connection: Connection,
  poolPubkey: PublicKey,
  rangeDownPct: number,
  rangeUpPct: number
): Promise<{
  feasible: boolean;
  newBinArrayCount: number;
  totalBins: number;
  binStep: number;
  activeBinId: number;
  minBinId: number;
  maxBinId: number;
  fullBinsDown: number;
  fullBinsUp: number;
  effectiveDownPct: number;
  effectiveUpPct: number;
}> {
  const DLMM = await getDLMM();
  const dlmmPool = await DLMM.create(connection, poolPubkey);
  const activeBin = await dlmmPool.getActiveBin();
  const activeBinId = activeBin.binId;
  const binStep = dlmmPool.lbPair.binStep;
  const s = binStep / 10000;

  // Use geometric (log) math to compute exact bin deltas for the target price changes.
  // Linear (pct / s) overestimates for large % moves because price is multiplicative.
  // This matches what the Meteora UI uses for -50% / +100% range selector (e.g. 140 bins vs 151 linear).
  const fullBinsDown = Math.abs(Math.round(Math.log((100 + rangeDownPct) / 100) / Math.log(1 + s)));
  const fullBinsUp = Math.round(Math.log((100 + rangeUpPct) / 100) / Math.log(1 + s));
  const fullDesiredMin = activeBinId - fullBinsDown;
  const fullDesiredMax = activeBinId + fullBinsUp;
  const fullTotalBins = fullDesiredMax - fullDesiredMin + 1;

  const { getBinArraysRequiredByPositionRange } = await import('@meteora-ag/dlmm');
  const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

  const requiredBinArrays = getBinArraysRequiredByPositionRange(
    poolPubkey,
    new BN(fullDesiredMin),
    new BN(fullDesiredMax),
    DLMM_PROGRAM_ID
  );

  let newBinArrayCount = 0;
  for (const ba of requiredBinArrays) {
    if (!(await connection.getAccountInfo(ba.key))) newBinArrayCount++;
  }

  const feasible = newBinArrayCount === 0;

  // Effective now reports the targeted price % (log math); linear bin-width would be ~70% for 50% price move.
  const effectiveDownPct = Math.abs(rangeDownPct);
  const effectiveUpPct = rangeUpPct;

  return {
    feasible,
    newBinArrayCount,
    totalBins: fullTotalBins,
    binStep,
    activeBinId,
    minBinId: fullDesiredMin,
    maxBinId: fullDesiredMax,
    fullBinsDown,
    fullBinsUp,
    effectiveDownPct,
    effectiveUpPct,
  };
}

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
 * CRITICAL SUCCESS CRITERIA (user directive):
 *   - No ZAP code path is used for opening. Entire bot purpose depends on reliably
 *     opening the full desired discrete range (-50% down / +100% up via round() bin math)
 *     using direct DLMM SDK + pre-swap for value match + zero new bin array gate.
 *   - If we cannot open such positions the bot has no purpose at all.
 *   - Pre-swap leg for the token side is *extremely* patient for any pool that
 *     already passed the hard full-range zero-rent gate: post-prequote settle delay +
 *     fresh-quote escalating attempts (in executeSwapFromPreQuote) + full ladder +
 *     a final "patient re-prequote + execute" wave (several seconds total trying)
 *     before giving up on an otherwise perfect deep survivor.
 *     See the pre-swap block and lib/swap.ts (PREQUOTE_MAX_ATTEMPTS / PREQUOTE_SLIPPAGE_LEVELS).
 */

import {
  Keypair, PublicKey, Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  Connection,
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
import { swapSolToToken, JUPITER_QUOTE_API, executeSwapFromPreQuote, PREQUOTE_MAX_ATTEMPTS } from '@/lib/swap'
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

import { swapTokenToSol } from '@/lib/swap'

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

    console.log(`${label} bin range validated: ${minBinId} → ${maxBinId} (${binRange} bins total, step=${feasibility.binStep})`);

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
      // Pre-quote at the *exact* split amount (solToSwapLamports) with 500bps.
      // Per design: X SOL budget → calc TOKEN for value match → gate on -50/+100 range (zero rent) →
      // then SWAP using this pre-quoted response (aggressively retried) → open with landed amounts.
      // The pre-quoted quoteResponse object is passed to executeSwapFromPreQuote which will
      // retry the *identical* quote (same route construction) multiple times with small backoff
      // before the caller falls back to a fresh ladder re-quote. This directly targets the
      // observed "pre-quote OK … 0x177e on first ladder 500" pattern on new Token-2022 pools.
      let quote: any = null
      try {
        const params = new URLSearchParams({
          inputMint: NATIVE_MINT_STR,
          outputMint: outputMint.toBase58(),
          amount: solToSwapLamports.toString(),
          slippageBps: '500',
          onlyDirectRoutes: 'false',
          restrictIntermediateTokens: 'true',
        })
        const quoteUrl = `${JUPITER_QUOTE_API}/quote?${params.toString()}`
        const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(7000) })
        if (!quoteRes.ok) throw new Error(`quote http ${quoteRes.status}`)
        quote = await quoteRes.json()
        if (quote?.error || quote?.errorCode) throw new Error(quote.error || quote.errorCode || 'quote error')
        const expectedOut = BigInt(quote.outAmount ?? quote.out_amount ?? '0')
        const routeHops = Array.isArray(quote.routePlan) ? quote.routePlan.length : 1;
        console.log(`${label} pre-quote OK: ${solToSwapLamports} SOL → ~${expectedOut} ${outputMint.toBase58().slice(0,8)} token (impact=${quote.priceImpactPct ?? quote.priceImpact ?? 'n/a'}, routeHops=${routeHops})`)
      } catch (e) {
        console.warn(`${label} pre-quote SOL→token failed — skipping pool: ${e instanceof Error ? e.message : e}`)
        return null
      }

      // Settle delay: many 0x177e on otherwise-valid quotes for new Token-2022 DLMMs are
      // transient (indexer propagation, thin liquidity window, hook timing). Give it a moment
      // before the first /swap (even with a fresh pre-quoted response). This pool already passed the
      // *critical* full-range gate (0 new bin arrays for the desired -50/+100 evil-panda range).
      const PRE_SWAP_SETTLE_MS = 1500;
      console.log(`${label} [swap] post-pre-quote settle ${PRE_SWAP_SETTLE_MS}ms (full-range pool, zero rent gate passed) ...`);
      await new Promise(r => setTimeout(r, PRE_SWAP_SETTLE_MS));

      // Call into executeSwapFromPreQuote (fresh quote on first try; on failure it escalates
      // with fresh quotes at higher slippage per PREQUOTE_SLIPPAGE_LEVELS rather than
      // re-submitting a stale route). Only after this + ladder do we consider the patient final wave.
      let swapRes = await executeSwapFromPreQuote(quote, getWallet(), label)
      if (!swapRes) {
        console.warn(`${label} pre-quote executor attempts exhausted — falling back to slippage ladder (fresh re-quotes)`)
        swapRes = await swapSolToToken(outputMint.toBase58(), solToSwapLamports, label)
      }

      // Patient final wave(s) for pools that are *exactly* the ones we must be able to open.
      // If everything (scanner score, lp_count, fee accel, full discrete range with 0 new arrays)
      // passed but the token leg swap keeps 0x177e'ing, we are failing the bot's core purpose.
      // We do the delayed fresh pre-quote + full escalating execute, and if it still fails
      // we do ONE MORE longer-delay cycle (super-patient mode) before giving up.
      if (!swapRes) {
        for (let wave = 1; wave <= 2; wave++) {
          const isLastWave = wave === 2;
          const delay = isLastWave ? 5000 : 2500;
          const waveLabel = isLastWave ? 'SUPER-PATIENT FINAL WAVE' : 'PATIENT FINAL WAVE';

          console.warn(`${label} prequote + ladder both failed for full -50/+100 range pool (0 new arrays) — ${waveLabel} #${wave}: sleep ${delay}ms then fresh pre-quote + ${PREQUOTE_MAX_ATTEMPTS} escalating attempts`);
          await new Promise(r => setTimeout(r, delay));

          let waveQuote: any = null;
          try {
            const paramsW = new URLSearchParams({
              inputMint: NATIVE_MINT_STR,
              outputMint: outputMint.toBase58(),
              amount: solToSwapLamports.toString(),
              slippageBps: '500',
              onlyDirectRoutes: 'false',
              restrictIntermediateTokens: 'true',
            });
            const quoteUrlW = `${JUPITER_QUOTE_API}/quote?${paramsW.toString()}`;
            const qResW = await fetch(quoteUrlW, { signal: AbortSignal.timeout(8000) });
            if (qResW.ok) {
              waveQuote = await qResW.json();
              if (waveQuote && !waveQuote.error && !waveQuote.errorCode) {
                const expW = BigInt(waveQuote.outAmount ?? waveQuote.out_amount ?? '0');
                const routeHopsW = Array.isArray(waveQuote.routePlan) ? waveQuote.routePlan.length : 1;
                console.log(`${label} ${waveLabel.toLowerCase()} pre-quote OK: ${solToSwapLamports} SOL → ~${expW} token (routeHops=${routeHopsW})`);
                swapRes = await executeSwapFromPreQuote(waveQuote, getWallet(), label);
              } else {
                console.warn(`${label} ${waveLabel.toLowerCase()} pre-quote had error`);
              }
            }
          } catch (waveErr) {
            console.warn(`${label} ${waveLabel.toLowerCase()} pre-quote fetch failed: ${waveErr instanceof Error ? waveErr.message : waveErr}`);
          }

          if (swapRes) {
            break; // success on this wave
          }

          if (!isLastWave) {
            console.warn(`${label} ${waveLabel.toLowerCase()} #${wave} still failed — will try one more super-patient cycle`);
          }
        }

        if (!swapRes) {
          console.error(`${label} swap SOL to token failed (after all patient + super-patient waves for full-range pool)`);
          return null;
        }
      }

      actualTokenLamports = swapRes.tokenAmount;
      console.log(`${label} swap done: received ${actualTokenLamports} token lamports`);
    } else {
      console.log(`${label} solBias produced zero token leg — proceeding with pure-SOL allocation for the Bid-Ask range`)
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

    // Rollback path (Claude critical #1): swap succeeded but the DLMM position creation failed.
    // We must try to return the tokens to SOL, otherwise they are stranded with no OpenLpPosition row
    // for the normal recovery path to discover.
    console.error(`${label} position open failed after successful pre-swap — attempting rollback to SOL`);
    try {
      const rollbackSig = await swapTokenToSol(outputMint.toBase58(), label);
      if (rollbackSig) {
        console.log(`${label} rollback swap back to SOL succeeded ✔ sig: ${rollbackSig}`);
      } else {
        console.warn(`${label} rollback returned no sig (dry-run or zero balance?)`);
      }
    } catch (rbErr) {
      console.error(`${label} rollback swapTokenToSol ALSO failed — persisting stranded token marker for monitor recovery`, rbErr);
      try {
        await persistStrandedTokenAfterFailedOpen(metrics, outputMint.toBase58(), actualTokenLamports);
      } catch (persistErr) {
        console.error(`${label} failed to persist stranded marker:`, persistErr);
      }
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
 * Direct SDK open for evil-panda Bid-Ask strategy (one-sided SOL + explicit Jupiter pre-swap for the token side).
 * Calls dlmmPool.initializePositionAndAddLiquidityByStrategy using the actual post-swap token amount
 * and the remaining SOL. Full desired range (no cap) is used only after the bin-array rent gate passes.
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

    // After explicit Jupiter swap for the token side (Bid-Ask one-sided distribution)
    const totalX = isTokenXSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())
    const totalY = isTokenYSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)

    console.log(
      `${label} using OFFICIAL direct DLMM SDK initializePositionAndAddLiquidityByStrategy ` +
      `(after Jupiter swap for token side, range ${minBinId} → ${maxBinId}, strategyType=${strategyType})`
    )
    console.log(`${label} totals for SDK call: totalX=${totalX.toString()} totalY=${totalY.toString()}`)

    const createPositionTxOrTxs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: totalX,
      totalYAmount: totalY,
      strategy: {
        minBinId,
        maxBinId,
        strategyType,
      },
    })

    const txsToSend = Array.isArray(createPositionTxOrTxs) ? createPositionTxOrTxs : [createPositionTxOrTxs]
    let liqSig = ''
    for (const tx of txsToSend) {
      const preparedTx = applyPriorityFee(tx, priorityFee)
      const sig = await sendLegacyTx(preparedTx, [wallet, positionKeypair], `${label} direct-sdk`)
      console.log(`${label} ✓ direct SDK position created & confirmed. Sig: ${sig}`)
      liqSig = sig
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

  const fullBinsDown = Math.abs(Math.round((rangeDownPct / 100) / (binStep / 10000)));
  const fullBinsUp = Math.round((rangeUpPct / 100) / (binStep / 10000));
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

  const effectiveDownPct = fullBinsDown * (binStep / 10000) * 100;
  const effectiveUpPct = fullBinsUp * (binStep / 10000) * 100;

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

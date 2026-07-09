/**
 * bot/executor/open/bin-calc.ts
 *
 * Bin range calculation for evil-panda Bid-Ask strategy.
 * - Target -50% / +100% (via strategy config)
 * - Discrete Math.round() log math to match Meteora UI
 * - Hard gate: zero new bin arrays (no non-refundable rent)
 * - Feasibility query + final assert
 *
 * Extracted from open.ts as part of god-file split. No behavior change.
 */

import { Connection, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { getDLMM } from '../utils'
import { getConnection } from '@/lib/solana'

/**
 * Hard last-moment verification that the chosen discrete bin range has **zero** missing bin arrays.
 * This is the final safeguard to guarantee we never pay non-refundable rent for new bin steps.
 *
 * Called immediately before we create the position account.
 * Throws (and aborts the open) if any required bin array is still missing.
 */
export async function assertNoNewBinArraysForRange(
  dlmmPool: any,
  minBinId: number,
  maxBinId: number,
  label: string
) {
  const { getBinArraysRequiredByPositionRange } = await import('@meteora-ag/dlmm');
  const requiredBinArrays = getBinArraysRequiredByPositionRange(
    dlmmPool.pubkey,
    new BN(minBinId),
    new BN(maxBinId),
    dlmmPool.program.programId
  );

  let missingCount = 0;
  const connection = getConnection();
  const keys = requiredBinArrays.map((ba: any) => ba.key);
  const infos = await connection.getMultipleAccountsInfo(keys);
  for (const info of infos) {
    if (!info) {
      missingCount++;
    }
  }

  if (missingCount > 0) {
    const err = new Error(
      `[CRITICAL][NON-REFUNDABLE RENT] About to pay position rent for range ${minBinId} → ${maxBinId} ` +
      `but ${missingCount} required bin array(s) are MISSING. Aborting HARD to avoid non-refundable rent.`
    );
    console.error(`${label} ${err.message}`);
    console.error(`${label} [TRACE] [ASSERT-BIN-FAIL] checked ${requiredBinArrays.length} arrays, ${missingCount} MISSING — HARD ABORT`);
    throw err;
  }

  console.log(
    `${label} ✅✅✅ VERIFIED (NO NON-REFUNDABLE BIN RENT): 0 new bin arrays for range ${minBinId} → ${maxBinId} ` +
    `(${requiredBinArrays.length} arrays already live on-chain).`
  );
  console.log(`${label} [TRACE] [ASSERT-BIN-OK] ✅✅✅ VERIFIED ZERO NEW BIN ARRAYS — WE ARE NOT PAYING ANY NON-REFUNDABLE BIN RENT FOR THIS RANGE. checked=${requiredBinArrays.length} missing=0`);
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
  rangeUpPct: number,
  existingPool?: any // reuse caller-created DLMM instance to avoid duplicate RPC creates
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
  const dlmmPool = existingPool || await (async () => {
    const DLMM = await getDLMM();
    return DLMM.create(connection, poolPubkey);
  })();
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

  // Use the same program ID that the SDK/pool object uses (no hardcode) so bin array PDA derivation
  // stays consistent with assertNoNewBinArraysForRange and any future program upgrades.
  const requiredBinArrays = getBinArraysRequiredByPositionRange(
    poolPubkey,
    new BN(fullDesiredMin),
    new BN(fullDesiredMax),
    dlmmPool.program.programId
  );

  const keys = requiredBinArrays.map((ba: any) => ba.key);
  const infos = await connection.getMultipleAccountsInfo(keys);
  const newBinArrayCount = infos.filter((i: any) => !i).length;

  const feasible = newBinArrayCount === 0;

  if (feasible) {
    console.log(`[TRACE] [FEASIBILITY] ✅ VERIFIED for pool: 0 new bin arrays needed for full desired range (totalBins=${fullTotalBins}, checked=${requiredBinArrays.length}). NO NON-REFUNDABLE RENT.`);
  } else {
    console.log(`[TRACE] [FEASIBILITY] range NOT free: newBinArrayCount=${newBinArrayCount} (would be non-refundable) — rejecting before any open attempt.`);
  }

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

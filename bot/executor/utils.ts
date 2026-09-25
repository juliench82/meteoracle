/**
 * bot/executor/utils.ts
 *
 * Single source of truth for shared helpers, constants, and lazy loaders
 * used across open.ts, close.ts, and add-liquidity.ts.
 */

import { PublicKey, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import BN from 'bn.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

export {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
};

// Re-export for consumers that need the raw constants (e.g. close.ts transfer-hook detection)


import { getConnection } from '@/lib/solana';
import type { Strategy } from '@/lib/types';
import { OPEN_LP_STATUSES, type OpenLpLimitState } from '@/lib/position-limits';
import { getOpenLpPositions } from '@/lib/local-state';
import { evilPandaStrategy } from '@/strategies/evil-panda';
import {
  MARKET_LP_SOL_PER_POSITION,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MAX_MARKET_LP_SOL_DEPLOYED,
} from '@/lib/strategy-config';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
export const NATIVE_MINT_STR = 'So11111111111111111111111111111111111111112';
export const ADD_LIQUIDITY_FALLBACK_CU = 1_400_000;

// ─────────────────────────────────────────────────────────────
// Open-path SOL / rent reserve (finding M1)
//
// Solana charges rent-exemption up front for every account. For the DLMM
// Position account this bot creates the size is
//     max(POSITION_HEADER_BYTES + numBins * BYTES_PER_BIN, MIN_POSITION_ACCOUNT_SIZE)
// and the real figures (audit M1 rent table, verified against the live
// `getMinimumBalanceForRentExemption`) are:
//     minimum account (8,192 B)                         0.0579 SOL
//     140 bins         (18,176 B)                       0.1274 SOL
//     220 bins         (28,416 B — MAX_SAFE_NUM_BINS)   0.1987 SOL
// The 0.07 the code used before this fix understated the 220-bin case by ~2x,
// before ATA rent and tx fees, so an open could pass the balance gate and then
// run out of SOL mid-scaffold (the exact failure mode the codebase defends
// against). The requirement is now derived from the ACTUAL account size.
// ─────────────────────────────────────────────────────────────
export const POSITION_HEADER_BYTES = 256;
export const BYTES_PER_BIN = 128; // must match the current Meteora DLMM Position layout
export const MIN_POSITION_ACCOUNT_SIZE = 8192;

/** Rent-exemption of one SPL associated token account (~165 B). Env-overridable. */
export const ATA_RENT_SOL = parseFloat(process.env.ATA_RENT_SOL ?? '0.00204');

/** Conservative headroom for tx/priority fees and rent-exemption drift. Env-overridable. */
export const OPEN_FEE_HEADROOM_SOL = parseFloat(process.env.OPEN_FEE_HEADROOM_SOL ?? '0.01');

/**
 * Conservative PRE-FLIGHT floor for the open balance gate, used where the exact
 * position size is not yet known (the early eligibility check — the bin range is
 * computed later).
 *
 * Worst case this code can create is MAX_SAFE_NUM_BINS = 220 bins -> 28,416 B
 * -> 0.1987 SOL rent, plus one ATA (0.00204) plus fee headroom (0.01) = 0.21074,
 * rounded up to 0.215. It therefore can never under-estimate the 220-bin worst
 * case. Once the range is known the caller uses computeOpenSolRequirement() with
 * the ACTUAL rent instead. (Was 0.07 — ~2x too low.)
 */
export const METEORA_RENT_RESERVE_SOL = 0.215;

// Consolidated: imported from strategy-config.ts (single source of env parsing with safe defaults)
export { MARKET_LP_SOL_PER_POSITION, MAX_CONCURRENT_MARKET_LP_POSITIONS, MAX_MARKET_LP_SOL_DEPLOYED, SWAP_BUY_SOL_AMOUNT } from '@/lib/strategy-config';

export const WALLET_MIN_SOL_RESERVE = parseFloat(process.env.WALLET_MIN_SOL_RESERVE ?? '0.1');

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

/**
 * On-chain size (bytes) of a DLMM Position account holding `numBins` bin
 * entries. Single source for the size used by both the scaffold and the rent
 * requirement. Must stay identical to the layout the executor has always used.
 */
export function computePositionAccountSize(numBins: number): number {
  return Math.max(POSITION_HEADER_BYTES + numBins * BYTES_PER_BIN, MIN_POSITION_ACCOUNT_SIZE);
}

export interface OpenSolRequirementInput {
  /** SOL leg that will be deposited into the position. */
  solAmount: number;
  /** ACTUAL rent-exemption (SOL) of the position account being created. */
  positionRentSol: number;
  /** Number of associated token accounts created for the open (default 1). */
  ataCount?: number;
  /** Fee/priority-fee headroom in SOL (default OPEN_FEE_HEADROOM_SOL). */
  feeHeadroomSol?: number;
}

/**
 * Exact SOL the wallet must hold to open a position, given the real position
 * rent for the account it will create:
 *   solAmount + positionRentSol + ataCount * ATA_RENT_SOL + feeHeadroomSol
 *
 * Pure — no RPC, no env beyond the defaults — so it is unit-testable and used
 * by the final pre-rent gates.
 */
export function computeOpenSolRequirement({
  solAmount,
  positionRentSol,
  ataCount = 1,
  feeHeadroomSol = OPEN_FEE_HEADROOM_SOL,
}: OpenSolRequirementInput): number {
  return solAmount + positionRentSol + ataCount * ATA_RENT_SOL + feeHeadroomSol;
}

/**
 * Exact pre-rent requirement for an open of `numBins` bins, using the ACTUAL
 * rent-exemption returned by the connection for the position account size.
 * Returns the derived figures so callers can log them.
 */
export async function computeOpenSolRequirementForBins(
  connection: { getMinimumBalanceForRentExemption(size: number): Promise<number> },
  { solAmount, numBins, ataCount, feeHeadroomSol }: {
    solAmount: number;
    numBins: number;
    ataCount?: number;
    feeHeadroomSol?: number;
  },
): Promise<{ requiredSol: number; positionRentSol: number; positionRentLamports: number; positionAccountSize: number }> {
  const positionAccountSize = computePositionAccountSize(numBins);
  const positionRentLamports = await connection.getMinimumBalanceForRentExemption(positionAccountSize);
  const positionRentSol = positionRentLamports / 1e9;
  const requiredSol = computeOpenSolRequirement({ solAmount, positionRentSol, ataCount, feeHeadroomSol });
  return { requiredSol, positionRentSol, positionRentLamports, positionAccountSize };
}

export function strategyTypeForDistribution(
  strategyTypeEnum: typeof import('@meteora-ag/dlmm').StrategyType,
  distributionType: Strategy['position']['distributionType'],
): any {
  const strategyTypeMap: Record<string, any> = {
    spot: strategyTypeEnum.Spot,
    curve: strategyTypeEnum.Curve,
    'bid-ask': strategyTypeEnum.BidAsk,
  };
  return strategyTypeMap[distributionType] ?? strategyTypeEnum.Spot;
}

export function findStrategyForPosition(position: Record<string, any>): Strategy | null {
  const strategyId = position.strategy_id ?? position.metadata?.strategy_id;
  // Only evil-panda is active; direct reference removes multi-strategy registry indirection.
  if (!strategyId || strategyId === evilPandaStrategy.id) {
    return evilPandaStrategy;
  }
  return null;
}

export async function getTotalDeployedSolForCap(
  limitState: OpenLpLimitState,
): Promise<{ totalDeployed: number; source: OpenLpLimitState['countSource'] }> {
  if (limitState.liveFetchOk) {
    const livePubkeys = (limitState as any).livePositions
      ?.map((p: any) => p.position_pubkey)
      .filter(Boolean) ?? [];

    if (livePubkeys.length === 0) {
      return { totalDeployed: 0, source: limitState.countSource };
    }

    // Use local-state + live on-chain data (no DB join)
    const totalDeployed = (limitState as any).livePositions?.reduce((sum: number, position: any) => {
      return sum + Number(position.sol_deposited ?? 0);
    }, 0) ?? 0;

    return { totalDeployed, source: limitState.countSource ?? 'live' as const };
  }

  // Use local state only
  const openPositions = getOpenLpPositions();
  const totalDeployed = openPositions
    .filter((p: any) => OPEN_LP_STATUSES.includes(p.status))
    .reduce((sum: number, p: any) => sum + Number(p.sol_deposited ?? 0), 0);

  return { totalDeployed, source: 'local-state' as const };
}

export async function getTokenProgramId(mint: PublicKey | string): Promise<PublicKey> {
  const connection = getConnection();

  // Safely convert input to PublicKey (handles both string and PublicKey)
  let mintPubkey: PublicKey;
  try {
    mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  } catch (e) {
    console.error(`[getTokenProgramId] Invalid mint address provided:`, mint);
    throw new Error(`Invalid mint address: ${mint}`);
  }

  // Try up to 3 times — getAccountInfo can be flaky right after a new mint appears (especially pump.fun graduates)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const info = await connection.getAccountInfo(mintPubkey);

      if (info?.owner) {
        const ownerStr = info.owner.toBase58();
        const t22 = TOKEN_2022_PROGRAM_ID.toBase58();
        const t1 = TOKEN_PROGRAM_ID.toBase58();

        if (ownerStr === t22) {
          console.log(`[getTokenProgramId] ${mintPubkey.toBase58().slice(0, 8)} → Token-2022 (attempt ${attempt})`);
          return info.owner;
        }

        if (ownerStr === t1) {
          return info.owner;
        }

        // Generic case: return whatever program actually owns this mint (including the 3rd program used by some pump.fun DLMM pairs)
        console.log(`[getTokenProgramId] ${mintPubkey.toBase58().slice(0, 8)} → Custom/Unknown program: ${ownerStr} (attempt ${attempt})`);
        return info.owner;
      }
    } catch (e) {
      console.warn(`[getTokenProgramId] attempt ${attempt} failed for ${mintPubkey.toBase58().slice(0, 8)}:`, e);
    }

    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }

  // Final fallback — assume legacy Token (most common case)
  console.warn(`[getTokenProgramId] ${mintPubkey.toBase58().slice(0, 8)} → Could not determine owner, assuming legacy Token`);
  return TOKEN_PROGRAM_ID;
}

export function getDecimalAdjustedPrice(dlmmPool: any, activeBin: any): number {
  if (!activeBin) return 0;
  try {
    const priceVal = activeBin.price ?? activeBin.pricePerLamport ?? '0';
    const adjusted = dlmmPool.fromPricePerLamport(Number(priceVal));
    const price = parseFloat(adjusted);
    if (isFinite(price) && price > 0) return price;
  } catch {}
  const fallback = activeBin.pricePerToken ?? activeBin.price ?? '0';
  const p = parseFloat(fallback);
  return isFinite(p) ? p : 0;
}

export async function getPositionWithRetry(
  dlmmPool: any,
  walletPubkey: PublicKey,
  positionPubkey: string,
  label: string,
  maxAttempts = 4,
  delayMs = 1500,
): Promise<any | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPubkey);
    const found = userPositions.find((p: { publicKey: PublicKey }) => p.publicKey.toBase58() === positionPubkey);
    if (found) return found;
    if (attempt < maxAttempts) {
      console.log(`${label} position not yet visible in API — retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}

export function getClaimableFeesUsd(position: Record<string, any>): number | null {
  const value = position.claimable_fees_usd ?? position.metadata?.claimable_fees_usd;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Lazy SDK Loaders
export async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm');
  return mod.default as typeof import('@meteora-ag/dlmm').default;
}

export async function getStrategyType() {
  const mod = await import('@meteora-ag/dlmm');
  return mod.StrategyType;
}

/**
 * Returns the accounts object for dlmmPool.program.methods.initializePosition(...)
 * using the names from the current @meteora-ag/dlmm client/IDL.
 */
export function getInitializePositionAccounts(
  dlmmPool: any,
  walletPubkey: PublicKey,
  positionPubkey: PublicKey,
  lbPairPubkey: PublicKey
) {
  return {
    payer: walletPubkey,
    position: positionPubkey,
    lbPair: lbPairPubkey,
    owner: walletPubkey,
    rent: SYSVAR_RENT_PUBKEY,
    // The IDL for initializePosition requires "program" (the LB program itself for events/CPI).
    // systemProgram (System) is handled implicitly (never in the resolved type).
    program: dlmmPool.program.programId,
  };
}

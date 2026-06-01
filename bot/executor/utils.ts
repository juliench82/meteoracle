/**
 * bot/executor/utils.ts
 *
 * Single source of truth for shared helpers, constants, and lazy loaders
 * used across open.ts, close.ts, and add-liquidity.ts.
 */

import { PublicKey } from '@solana/web3.js';
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
import { STRATEGIES } from '@/strategies';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
export const NATIVE_MINT_STR = 'So11111111111111111111111111111111111111112';
export const METEORA_RENT_RESERVE_SOL = 0.07;
export const ADD_LIQUIDITY_FALLBACK_CU = 1_400_000;

export const DLMM_ZAP_SWAP_SLIPPAGE_BPS = 200; // Aligned with SWAP_SLIPPAGE_BPS default (Section 6.5)
export const DLMM_ZAP_MAX_ACTIVE_BIN_SLIPPAGE = 10;
export const DLMM_ZAP_MAX_ACCOUNTS = 48;
export const DLMM_ZAP_MAX_TRANSFER_EXTEND_PERCENTAGE = 2;

export const MAX_BINS_BY_STRATEGY: Record<string, number> = {
  'evil-panda':    150,
};
export const MAX_BINS_DEFAULT = 150;

export const MARKET_LP_SOL_PER_POSITION = parseFloat(
  process.env.MAX_MARKET_LP_SOL_PER_POSITION ??
  process.env.MARKET_LP_SOL_PER_POSITION ??
  process.env.MAX_SOL_PER_POSITION ??
  '0.1'
);

export const MAX_CONCURRENT_MARKET_LP_POSITIONS = parseInt(
  process.env.MAX_CONCURRENT_MARKET_LP_POSITIONS ?? process.env.MAX_CONCURRENT_POSITIONS ?? '5'
);

export const MAX_MARKET_LP_SOL_DEPLOYED = parseFloat(
  process.env.MAX_MARKET_LP_SOL_DEPLOYED ?? process.env.MAX_TOTAL_SOL_DEPLOYED ?? '1'
);

export const WALLET_MIN_SOL_RESERVE = parseFloat(process.env.WALLET_MIN_SOL_RESERVE ?? '0.1');

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────
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
  return STRATEGIES.find((s) => s.id === strategyId) ?? null;
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

export function getDecimalAdjustedPrice(dlmmPool: any, activeBin: { price: string; pricePerToken: string }): number {
  try {
    const adjusted = dlmmPool.fromPricePerLamport(Number(activeBin.price));
    const price = parseFloat(adjusted);
    if (isFinite(price) && price > 0) return price;
  } catch {}
  return parseFloat(activeBin.pricePerToken);
}

/**
 * Calculates the actual bin range needed for a strategy's % range on a specific pool's binStep.
 * Applies proportional shrinking if the range would exceed the strategy's max bins.
 */
export function calculateValidatedBinRange(
  activeBinId: number,
  binStep: number,
  rangeDownPct: number,
  rangeUpPct: number,
  maxBins: number,
  label: string
): { minBinId: number; maxBinId: number; binRange: number; wasShrunk: boolean } {
  let binsDown = Math.abs(Math.round((rangeDownPct / 100) / (binStep / 10000)));
  let binsUp = Math.round((rangeUpPct / 100) / (binStep / 10000));
  let binRange = binsDown + binsUp;
  let wasShrunk = false;

  if (binRange > maxBins) {
    const shrinkRatio = maxBins / binRange;
    binsDown = Math.floor(binsDown * shrinkRatio);
    binsUp = maxBins - binsDown;
    binRange = binsDown + binsUp;
    wasShrunk = true;

    console.log(
      `${label} bin range auto-shrunk to respect strategy limit (${binRange} bins instead of ~${Math.round(binRange / shrinkRatio)})`
    );
  }

  const minBinId = activeBinId - binsDown;
  const maxBinId = activeBinId + binsUp;

  return { minBinId, maxBinId, binRange, wasShrunk };
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

export async function getZap() {
  const mod = await import('@meteora-ag/zap-sdk');
  return new mod.Zap(getConnection());
}

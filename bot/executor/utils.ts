/**
 * bot/executor/utils.ts
 *
 * Single source of truth for shared helpers, constants, and lazy loaders
 * used across open.ts, close.ts, and add-liquidity.ts.
 */

import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { getConnection } from '@/lib/solana';
import { createServerClient } from '@/lib/supabase';
import type { Strategy } from '@/lib/types';
import { OPEN_LP_STATUSES, type OpenLpLimitState } from '@/lib/position-limits';
import { STRATEGIES } from '@/strategies';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
export const NATIVE_MINT_STR = 'So11111111111111111111111111111111111111112';
export const METEORA_RENT_RESERVE_SOL = 0.07;
export const ADD_LIQUIDITY_FALLBACK_CU = 1_400_000;

export const DLMM_ZAP_SWAP_SLIPPAGE_BPS = 100;
export const DLMM_ZAP_MAX_ACTIVE_BIN_SLIPPAGE = 10;
export const DLMM_ZAP_MAX_ACCOUNTS = 48;
export const DLMM_ZAP_MAX_TRANSFER_EXTEND_PERCENTAGE = 2;

export const MAX_BINS_BY_STRATEGY: Record<string, number> = {
  'evil-panda':    200,
  'scalp-spike':   120,
  'bluechip-farm': 100,
  'stable-farm':   100,
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
  supabase: ReturnType<typeof createServerClient>,
  limitState: OpenLpLimitState,
): Promise<{ totalDeployed: number; source: OpenLpLimitState['countSource'] }> {
  if (limitState.liveFetchOk) {
    const livePubkeys = limitState.livePositions
      .map((p) => p.position_pubkey)
      .filter(Boolean);

    if (livePubkeys.length === 0) {
      return { totalDeployed: 0, source: limitState.countSource };
    }

    const { data, error } = await supabase
      .from('lp_positions')
      .select('position_pubkey, sol_deposited')
      .in('position_pubkey', livePubkeys);

    if (error) {
      console.warn(`[executor] live exposure DB join failed; using Meteora live estimates: ${error.message}`);
    }

    const cachedSolByPubkey = new Map(
      (data ?? []).map((row: any) => [row.position_pubkey, Number(row.sol_deposited ?? 0)])
    );

    const totalDeployed = limitState.livePositions.reduce((sum, position) => {
      const cachedSol = cachedSolByPubkey.get(position.position_pubkey) ?? 0;
      const liveSol = Number(position.sol_deposited ?? 0);
      return sum + (cachedSol > 0 ? cachedSol : liveSol);
    }, 0);

    return { totalDeployed, source: limitState.countSource };
  }

  const { data: openPositions } = await supabase
    .from('lp_positions')
    .select('sol_deposited')
    .in('status', OPEN_LP_STATUSES);

  const totalDeployed = (openPositions ?? []).reduce(
    (sum: number, row: { sol_deposited: number | null }) => sum + Number(row.sol_deposited ?? 0),
    0
  );

  return { totalDeployed, source: 'supabase-cache' as const };
}

export async function getTokenProgramId(mint: PublicKey): Promise<PublicKey> {
  const connection = getConnection();
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1KLm5i');
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  // Try up to 3 times — getAccountInfo can be flaky right after a new mint appears (especially pump.fun graduates)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const info = await connection.getAccountInfo(mint);
      if (info) {
        const owner = info.owner.toBase58();
        if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
          console.log(`[getTokenProgramId] ${mint.toBase58().slice(0, 8)} → Token-2022 (owner match on attempt ${attempt})`);
          return TOKEN_2022_PROGRAM_ID;
        }
        if (owner === TOKEN_PROGRAM_ID.toBase58()) {
          return TOKEN_PROGRAM_ID;
        }
      }
    } catch (e) {
      console.warn(`[getTokenProgramId] attempt ${attempt} failed for ${mint.toBase58().slice(0, 8)}:`, e);
    }
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }

  // Final fallback — assume legacy (most common case)
  console.log(`[getTokenProgramId] ${mint.toBase58().slice(0, 8)} → assuming legacy Token program (detection exhausted)`);
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

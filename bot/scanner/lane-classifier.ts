/**
 * lane-classifier.ts
 *
 * Clean, small lane classification for the simplified architecture.
 *
 * This is now the authoritative (but intentionally simple) module for:
 * - Splitting pools into fresh vs momentum lanes
 * - Picking survivors for deep checks
 * - Basic best-pool selection
 *
 * Goal: small, understandable, no fake complexity.
 */

import type { MeteoraPool } from './pool-fetcher';
import {
  getPoolAgeMinutes,
  getPoolTvl,
  getPoolVolume,
  getFeeTvlPct,
  getTradableToken,
} from './pool-fetcher';

export type LaneConfig = {
  freshMaxAgeMinutes?: number;
  freshMinLiquidityUsd?: number;
  momentumMinVolume5mUsd?: number;
  momentumMinFeeTvl5mPct?: number;
  maxFreshDeepChecks?: number;
  maxMomentumDeepChecks?: number;
};

export type Survivor = {
  pool: MeteoraPool;
  ageHours: number;
  lane: 'fresh' | 'momentum';
};

/**
 * Simple classification.
 * Fresh = young + enough liquidity.
 * Momentum = showing clear recent activity (volume or fees).
 */
export function classifyPoolsIntoLanes(pools: MeteoraPool[], config: LaneConfig = {}) {
  const freshMax = config.freshMaxAgeMinutes ?? 90;
  const freshMinLiq = config.freshMinLiquidityUsd ?? 15_000;
  const momVol = config.momentumMinVolume5mUsd ?? 2500;
  const momFee = config.momentumMinFeeTvl5mPct ?? 0.8;

  const freshPools: MeteoraPool[] = [];
  const momentumPools: MeteoraPool[] = [];

  for (const p of pools) {
    const ageMin = getPoolAgeMinutes(p);
    const liq = getPoolTvl(p);
    const vol5m = getPoolVolume(p, '5m');
    const fee5m = getFeeTvlPct(p, '5m');

    const isFresh = ageMin <= freshMax && liq >= freshMinLiq;

    if (isFresh) {
      freshPools.push(p);
    } else if (vol5m >= momVol || fee5m >= momFee) {
      momentumPools.push(p);
    }
  }

  const maxFresh = config.maxFreshDeepChecks ?? 12;
  const maxMom = config.maxMomentumDeepChecks ?? 8;

  return {
    freshPools,
    momentumPools,
    freshSurvivors: freshPools.slice(0, maxFresh),
    momentumSurvivors: momentumPools.slice(0, maxMom),
  };
}

/**
 * Combine survivors from both lanes and filter out recently closed OOR positions.
 */
export function pickDeepCheckSurvivors(
  fresh: MeteoraPool[],
  momentum: MeteoraPool[],
  recentlyClosedOorMints: Set<string>,
  config: LaneConfig = {}
): Survivor[] {
  const out: Survivor[] = [];
  const maxTotal = (config.maxFreshDeepChecks ?? 12) + (config.maxMomentumDeepChecks ?? 8);

  const add = (pool: MeteoraPool, lane: 'fresh' | 'momentum') => {
    if (out.length >= maxTotal) return;
    const trad = getTradableToken(pool);
    const mint = trad?.address;
    if (mint && recentlyClosedOorMints.has(mint)) return;

    out.push({
      pool,
      ageHours: getPoolAgeMinutes(pool) / 60,
      lane,
    });
  };

  for (const p of fresh) add(p, 'fresh');
  for (const p of momentum) add(p, 'momentum');

  return out;
}

export function survivorTokenAddress(s: Survivor | MeteoraPool | any): string {
  if (!s) return '';
  const pool = s.pool ?? s;
  const t = getTradableToken(pool);
  return t?.address || pool?.address || s.mint || '';
}

/**
 * Very simple best pool selection for the simplified model.
 * No fake bin compatibility scoring.
 */
export function selectBestPool(
  pools: MeteoraPool[] | any,
  tokenAddress: string
): { pool: MeteoraPool | null } {
  const list: MeteoraPool[] = Array.isArray(pools) ? pools : [];
  if (list.length === 0) return { pool: null };

  // Exact match on the tradable token
  const exact = list.find(p => getTradableToken(p)?.address === tokenAddress);
  if (exact) return { pool: exact };

  // Fallback: first pool in the list for this token group
  return { pool: list[0] };
}

/** Simple momentum regain signal */
export function passesMomentumRegain(pool: MeteoraPool | any): boolean {
  if (!pool) return false;
  const fee5m = getFeeTvlPct(pool, '5m') || 0;
  const vol5m = getPoolVolume(pool, '5m') || 0;
  return fee5m >= 1.2 || vol5m >= 2500;
}

// --- Compatibility shims (kept minimal) ---
export const scalpSpikeStrategy = { id: 'scalp-spike', enabled: false } as any;

export function getOneHourFeeTvlVs24hAverage(pool: any) {
  const f1 = getFeeTvlPct(pool, '1h') || 0;
  const f24 = getFeeTvlPct(pool, '24h') || 0;
  return f24 > 0 ? Math.min(4, f1 / f24) : 1;
}

export function getOneHourVolumeVs24hAverage(pool: any) {
  const v1 = getPoolVolume(pool, '1h') || 0;
  const v24 = getPoolVolume(pool, '24h') || 0;
  return v24 > 0 ? Math.min(4, v1 / v24) : 1;
}

export function passesMomentumRegainStrategyFilters(_: any) {
  return false;
}

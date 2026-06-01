/**
 * lane-classifier.ts
 *
 * Ultra-simplified fresh-only filter.
 *
 * In the minimal model:
 * - Only pools with age <= MAX_POOL_AGE_MINUTES are kept
 * - No momentum lane
 *
 * Handles:
 * - Age-based filtering
 * - Limited survivor selection
 * - Best pool by liquidity (highest TVL)
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
  maxPoolAgeMinutes?: number;
  maxFreshDeepChecks?: number;
};

export type Survivor = {
  pool: MeteoraPool;
  ageHours: number;
};

/**
 * Ultra-minimal classification.
 * We only keep pools that are fresh (age <= MAX_POOL_AGE_MINUTES).
 */
export function classifyPoolsIntoLanes(pools: MeteoraPool[], config: LaneConfig = {}) {
  const maxAge = config.maxPoolAgeMinutes ?? 30;
  const maxChecks = config.maxFreshDeepChecks ?? 12;

  const freshPools: MeteoraPool[] = [];

  for (const p of pools) {
    const ageMin = getPoolAgeMinutes(p);
    if (ageMin <= maxAge) {
      freshPools.push(p);
    }
  }

  return {
    freshPools,
    momentumPools: [],                    // Momentum lane fully removed
    freshSurvivors: freshPools.slice(0, maxChecks),
    momentumSurvivors: [],
  };
}

/**
 * Take fresh survivors and filter out recently closed OOR positions.
 */
export function pickDeepCheckSurvivors(
  fresh: MeteoraPool[],
  recentlyClosedOorMints: Set<string>,
  config: LaneConfig = {}
): Survivor[] {
  const out: Survivor[] = [];
  const maxTotal = config.maxFreshDeepChecks ?? 12;

  for (const p of fresh) {
    if (out.length >= maxTotal) break;

    const trad = getTradableToken(p);
    const mint = trad?.address;
    if (mint && recentlyClosedOorMints.has(mint)) continue;

    out.push({
      pool: p,
      ageHours: getPoolAgeMinutes(p) / 60,
    });
  }

  return out;
}

export function survivorTokenAddress(s: Survivor | MeteoraPool | any): string {
  if (!s) return '';
  const pool = s.pool ?? s;
  const t = getTradableToken(pool);
  return t?.address || pool?.address || s.mint || '';
}

/**
 * Best pool selection for the simplified model.
 *
 * Rule (per Section 6.2 of the simplification plan):
 * When multiple Meteora pools/tiers exist for the same token,
 * prefer the one with the **highest liquidity (TVL)**.
 *
 * This is the primary quality filter for pool tier selection.
 * Future tie-breakers (binStep compatibility, fee/TVL, etc.) can be added here.
 */
export function selectBestPool(
  pools: MeteoraPool[] | any,
  tokenAddress: string
): { pool: MeteoraPool | null } {
  const list: MeteoraPool[] = Array.isArray(pools) ? pools : [];
  if (list.length === 0) return { pool: null };

  // All pools that match this exact tradable token
  const candidates = list.filter(p => getTradableToken(p)?.address === tokenAddress);

  if (candidates.length === 0) {
    // Fallback to first in the broader list (should be rare)
    return { pool: list[0] };
  }

  if (candidates.length === 1) {
    return { pool: candidates[0] };
  }

  // Multiple tiers exist for this token → pick the one with highest liquidity (TVL)
  const best = candidates.reduce((prev, curr) => {
    const prevTvl = getPoolTvl(prev);
    const currTvl = getPoolTvl(curr);
    return currTvl > prevTvl ? curr : prev;
  });

  return { pool: best };
}

/**
 * Legacy momentum regain signal.
 * No longer used for opening decisions in the ultra-minimal model.
 * Kept only for temporary compatibility in pool-fetcher.
 * TODO: Remove in cleanup pass.
 */
export function passesMomentumRegain(pool: MeteoraPool | any): boolean {
  if (!pool) return false;
  const fee5m = getFeeTvlPct(pool, '5m') || 0;
  const vol5m = getPoolVolume(pool, '5m') || 0;
  return fee5m >= 1.2 || vol5m >= 2500;
}

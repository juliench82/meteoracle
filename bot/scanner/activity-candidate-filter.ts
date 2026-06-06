/**
 * activity-candidate-filter.ts
 *
 * Helper functions for activity-qualified pool filtering and selection (post server list).
 *
 * Per spec the heavy lifting (sort_by=fee_tvl_ratio_1h:desc + core filter_by) is done by the
 * datapi /pools list call. The fetcher applies the client secondary derives (implied, accel, age, SOL).
 * This module handles capping, OOR dedup, best-of-token selection, and preparing the final ~top-5
 * for LP enrichment + deep checks.
 */

import type { MeteoraPool } from './pool-fetcher';
import {
  getPoolAgeMinutes,
  getPoolTvl,
  getPoolVolume,
  getFeeTvlPct,
  getTradableToken,
} from './pool-fetcher';
import {
  getFeesActiveTvl24hPct,
} from './pool-metrics';

// Config for candidate selection
export type ActivityFilterConfig = {
  maxPoolAgeMinutes?: number;
  maxCandidates?: number;
};

export type ActivityCandidate = {
  pool: MeteoraPool;
  ageHours: number;
};

/**
 * Returns the pools that reached this point (they already passed the real documented
 * API filters + derived proxies in pool-fetcher).
 */
export function filterActivityPools(pools: MeteoraPool[], config: ActivityFilterConfig = {}) {
  const maxCandidates = config.maxCandidates ?? 12;
  return {
    activityPools: pools,
    candidates: pools.slice(0, maxCandidates),
  };
}

/**
 * Apply OOR dedup and cap the list of activity-qualified candidates.
 */
export function selectTopCandidates(
  activityPools: MeteoraPool[],
  recentlyClosedOorMints: Set<string>,
  config: ActivityFilterConfig = {}
): ActivityCandidate[] {
  const out: ActivityCandidate[] = [];
  const maxTotal = config.maxCandidates ?? 12;

  for (const p of activityPools) {
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

/**
 * Sort the qualified pools by the recommended recency signal (fee_tvl_ratio_1h) DESC
 * and take the top N (we then do lp_count enrichment + deep checks on them).
 */
export function selectTopByActiveYield(
  pools: MeteoraPool[],
  maxN = 5
): MeteoraPool[] {
  const sorted = [...pools].sort((a, b) => {
    const ya = getFeesActiveTvl24hPct(a);
    const yb = getFeesActiveTvl24hPct(b);
    return yb - ya; // DESC
  });
  return sorted.slice(0, maxN);
}

export function candidateTokenAddress(c: ActivityCandidate | MeteoraPool | any): string {
  if (!c) return '';
  const pool = c.pool ?? c;
  const t = getTradableToken(pool);
  return t?.address || pool?.address || (c as any).mint || '';
}

/**
 * Best pool selection (used inside the top-N activity list).
 *
 * When multiple Meteora pools/tiers exist for the same token inside the
 * fees/active-24h sorted top performers, prefer the one with the highest 24h Fee/TVL.
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

  // Multiple tiers exist for this token → pick the one with highest 24h Fee/TVL
  const best = candidates.reduce((prev, curr) => {
    const prevFeeTvl = getFeeTvlPct(prev, '24h');
    const currFeeTvl = getFeeTvlPct(curr, '24h');
    return currFeeTvl > prevFeeTvl ? curr : prev;
  });

  return { pool: best };
}

// (passesMomentumRegain fully removed — no longer used)

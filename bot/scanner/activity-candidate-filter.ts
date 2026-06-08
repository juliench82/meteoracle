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
 * Apply OOR dedup + same-token dedup (multiple DLMM tiers per mint are common)
 * and cap the list of activity-qualified candidates.
 * The returned list contains at most one entry per tradable mint.
 */
export function selectTopCandidates(
  activityPools: MeteoraPool[],
  recentlyClosedOorMints: Set<string>,
  config: ActivityFilterConfig = {}
): ActivityCandidate[] {
  const out: ActivityCandidate[] = [];
  const maxTotal = config.maxCandidates ?? 12;
  const seenMints = new Set<string>();

  for (const p of activityPools) {
    if (out.length >= maxTotal) break;

    const trad = getTradableToken(p);
    const mint = trad?.address;

    // Skip recently OOR-closed tokens (when the set is populated)
    if (mint && recentlyClosedOorMints.has(mint)) continue;

    // Dedup by tradable mint: Meteora DLMM frequently surfaces multiple active pools/tiers
    // for the same token. We only need (and want to lp-enrich) one per token per tick.
    if (mint && seenMints.has(mint)) continue;

    out.push({
      pool: p,
      ageHours: getPoolAgeMinutes(p) / 60,
    });
    if (mint) seenMints.add(mint);
  }

  return out;
}

/**
 * @deprecated Unused in the main path (main selection uses inline 1h fee_tvl sort after prefilter).
 * Sorts by 24h active yield (getFeesActiveTvl24hPct) which does not match the spec's "fee_tvl_ratio_1h:desc" recency preference.
 * Kept only for possible future alternative use; do not rely on it for current "top performer" selection.
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
  const list: any[] = Array.isArray(pools) ? pools : [];
  if (list.length === 0) return { pool: null };

  // Normalize items that may be ActivityCandidate wrappers { pool, ageHours }
  // (the wrapped list in scanner tick context).
  // Always return a raw MeteoraPool.
  const normalized = list
    .map((item: any) => item?.pool ?? item)
    .filter((p: any): p is MeteoraPool => !!p && p.token_x && p.token_y);

  // All pools that match this exact tradable token
  const candidates = normalized.filter(p => getTradableToken(p)?.address === tokenAddress);

  if (candidates.length === 0) {
    // No pools in the provided list match this token at all. Return null so caller can skip cleanly.
    // (Previously fell back to list[0], which could be for an unrelated token.)
    return { pool: null };
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

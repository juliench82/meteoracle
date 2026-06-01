/**
 * fresh-pool-filter.ts
 *
 * Ultra-minimal fresh-only filter for the age-based scanner.
 *
 * Responsibilities:
 * - Age gate: only pools with age <= MAX_POOL_AGE_MINUTES
 * - Cap the number of candidates we process
 * - Highest-liquidity pool selection when multiple tiers exist for one token
 *
 * This is the entire "brain" for the ultra-simple model. No lanes. No momentum. No scoring.
 */

import type { MeteoraPool } from './pool-fetcher';
import {
  getPoolAgeMinutes,
  getPoolTvl,
  getPoolVolume,
  getFeeTvlPct,
  getTradableToken,
} from './pool-fetcher';

// Minimal config for the fresh-only age-based path
export type FreshFilterConfig = {
  maxPoolAgeMinutes?: number;
  maxCandidates?: number;   // how many fresh pools we will deep-check per tick
};

export type FreshCandidate = {
  pool: MeteoraPool;
  ageHours: number;
};

/**
 * Ultra-simple fresh filter.
 * Returns only pools that pass the age gate, capped for processing.
 */
export function filterFreshPools(pools: MeteoraPool[], config: FreshFilterConfig = {}) {
  const maxAge = config.maxPoolAgeMinutes ?? 30;
  const maxCandidates = config.maxCandidates ?? 12;

  const fresh: MeteoraPool[] = [];

  for (const p of pools) {
    const ageMin = getPoolAgeMinutes(p);
    if (ageMin <= maxAge) {
      fresh.push(p);
    }
  }

  return {
    freshPools: fresh,
    candidates: fresh.slice(0, maxCandidates),
  };
}

/**
 * Take fresh pools, apply OOR dedup, and return capped list of candidates to deep-check.
 */
export function selectFreshCandidates(
  fresh: MeteoraPool[],
  recentlyClosedOorMints: Set<string>,
  config: FreshFilterConfig = {}
): FreshCandidate[] {
  const out: FreshCandidate[] = [];
  const maxTotal = config.maxCandidates ?? 12;

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

export function candidateTokenAddress(c: FreshCandidate | MeteoraPool | any): string {
  if (!c) return '';
  const pool = c.pool ?? c;
  const t = getTradableToken(pool);
  return t?.address || pool?.address || (c as any).mint || '';
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

// (passesMomentumRegain fully removed — no longer used)

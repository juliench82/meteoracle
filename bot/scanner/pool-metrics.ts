/**
 * pool-metrics.ts
 *
 * Pool metric getters and derived proxies (per revised top-performer activity spec).
 *
 * - impliedActiveTVL = fees_1h / fee_tvl_ratio_1h * 100  (reproduces the pool's real `tvl`; see getImpliedActiveTvl)
 * - isFeeAccelerating = fee_1h > (fee_2h / 2)
 * - getUniqueLpCount (expensive, only on final survivors) via getProgramAccounts on DLMM program
 *
 * Current model uses only real fields from the /pools list API + derivations.
 * Some getters for fields the current /pools API does not return are kept for compatibility.
 */

import type { MeteoraPool } from './pool-fetcher';
import {
  MIN_FEE_24H,
  LP_SCORE_FEE_TVL_1H_WEIGHT,
  LP_SCORE_FEE_TVL_24H_WEIGHT,
  LP_SCORE_LP_COUNT_WEIGHT,
  LP_SCORE_LP_CAP,
} from '@/lib/strategy-config';
import { getHeliusRpcEndpoint } from '@/lib/solana';

type UnknownRecord = Record<string, unknown>;

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

export function getPoolTvl(pool: MeteoraPool): number {
  return asNumber(pool.tvl, 0);
}

export function getPoolVolume(pool: MeteoraPool, window: string): number {
  const flatKey = `volume_${window}` as keyof MeteoraPool;
  const direct = asNumber(pool.volume?.[window] ?? pool[flatKey], Number.NaN);
  if (Number.isFinite(direct)) return direct;

  if (window === '5m') {
    const thirtyMinuteVolume = asNumber(pool.volume?.['30m'], Number.NaN);
    if (Number.isFinite(thirtyMinuteVolume)) return thirtyMinuteVolume / 6;
  }

  return 0;
}

export function getFeeTvlRatio(pool: MeteoraPool, window: string): number {
  const flatKey = `fee_tvl_ratio_${window}` as keyof MeteoraPool;
  const direct = asNumber(pool.fee_tvl_ratio?.[window] ?? pool[flatKey], Number.NaN);
  if (Number.isFinite(direct)) return direct;

  if (window === '5m') {
    const thirtyMinuteRatio = asNumber(pool.fee_tvl_ratio?.['30m'], Number.NaN);
    if (Number.isFinite(thirtyMinuteRatio)) return thirtyMinuteRatio / 6;
  }

  return 0;
}

/**
 * 24h/1h/… Fee/TVL ratio for a pool, ALREADY expressed as a percentage.
 *
 * `dlmm.datapi.meteora.ag` returns `fee_tvl_ratio` as a PERCENT — it is
 * `fees[window] / tvl * 100`, not `fees[window] / tvl`. Proof (recorded live,
 * 2026-09-25, 22/22 pools the scanner actually selected, committed as
 * `tests/fixtures/fee-tvl-selected-pools.json`): for every pool
 * `fee_tvl_ratio['24h'] == fees['24h'] / tvl * 100` to 10 decimal places,
 * and it differs from the raw `fees/tvl` ratio. Same finding as audit §H1
 * (8/8 live pools).
 *
 * Do NOT multiply by 100 here — that was the H1 defect (units wrong by 100×),
 * which made the primary exit rule (bot/monitor.ts rule #1) compare a value
 * 100× too large against the exit threshold and therefore never fire.
 */
export function getFeeTvlPct(pool: MeteoraPool, window: string): number {
  return getFeeTvlRatio(pool, window);
}

export function getVolumeTvlRatio(pool: MeteoraPool, window: string): number {
  const tvl = getPoolTvl(pool);
  return tvl > 0 ? getPoolVolume(pool, window) / tvl : 0;
}

export function getRecentVolumeGrowth(pool: MeteoraPool): number {
  const vol5mAnnualizedTo1h = getPoolVolume(pool, '5m') * 12;
  const vol1h = getPoolVolume(pool, '1h');
  if (vol1h <= 0) return vol5mAnnualizedTo1h > 0 ? 3 : 0;
  return vol5mAnnualizedTo1h / vol1h;
}

// ─── Compatibility getters (for fields the current /pools API does not return) ───
// Kept so that older code or external consumers don't break. Current active path uses real fields + proxies.

export function getActiveTvlUsd(pool: MeteoraPool): number {
  const explicit = asNumber(
    pool.active_tvl_usd ?? pool.active_tvl ?? (pool as any).activeTvlUsd ?? (pool as any).activeTvl,
    Number.NaN
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return getPoolTvl(pool);
}

export function getTotalLps(pool: MeteoraPool): number {
  const explicit = asNumber(
    pool.total_lps ?? pool.lp_count ?? (pool as any).lps ?? (pool as any).lpCount,
    Number.NaN
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return 0;
}

export function getFeesActiveTvl24hPct(pool: MeteoraPool): number {
  const explicit = asNumber(
    pool.fees_active_tvl_24h ?? (pool as any).feesActiveTvl24h ?? (pool as any).feeActiveTvl24h,
    Number.NaN
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return getFeeTvlPct(pool, '24h');
}

export function getTvlChange24h(pool: MeteoraPool): number {
  const explicit = asNumber(
    pool.tvl_change_24h ?? (pool as any).tvlChange24h,
    Number.NaN
  );
  if (Number.isFinite(explicit)) return explicit;
  return 0;
}

export function getFeesChange24h(pool: MeteoraPool): number {
  const explicit = asNumber(
    pool.fees_change_24h ?? (pool as any).feesChange24h ?? (pool as any).feeChange24h,
    Number.NaN
  );
  if (Number.isFinite(explicit)) return explicit;
  const f = pool.fees || {};
  const f24 = asNumber(f['24h'] ?? f['24H'], 0);
  const f12 = asNumber(f['12h'] ?? f['12H'], 0);
  if (f24 > 0 && f12 > 0) {
    // Return percentage change (not absolute delta) so it is consistent with
    // expected "chg" semantics in logs and any future rules.
    return ((f24 - f12) / f12) * 100;
  }
  return 0;
}

// ─── Current real API field proxies (per official docs + latest Claude recommendations) ───

/**
 * Tolerance for the fee-derived TVL vs the API's own `tvl`.
 *
 * The derivation below is mathematically identical to `tvl`
 * (`fee_tvl_ratio_1h` is `fees_1h / tvl * 100`), so any relative disagreement
 * beyond this is a malformed/partial payload — in that case fall back to the
 * API's `tvl`.
 */
export const IMPLIED_ACTIVE_TVL_TOLERANCE = 0.01; // 1% relative

/**
 * Implied active TVL — the pool's real, currently-earning liquidity in true USD,
 * derived from actual trading flow rather than parked capital.
 *
 *   fees_1h / (fee_tvl_ratio_1h / 100)   ==   fees_1h * 100 / fee_tvl_ratio_1h
 *
 * `fee_tvl_ratio_1h` is the API's ALREADY-PERCENT 1h fees/TVL ratio
 * (`fees_1h / tvl * 100` — see `getFeeTvlPct`), so the two cancel and this
 * reproduces the pool's real `tvl` exactly. Verified on the recorded live
 * candidate set (`tests/fixtures/implied-active-tvl-candidate-pools.json`,
 * recorded 2026-09-25): 398/398 pools across two captures matched `tvl` to a
 * max abs diff of 2.3e-10.
 *
 * Falls back to the API's own `tvl` (`getPoolTvl`) when the derivation is
 * unavailable (missing/zero `fees_1h` or `fee_tvl_ratio_1h`) or when it disagrees
 * with `tvl` beyond `IMPLIED_ACTIVE_TVL_TOLERANCE`.
 *
 * Replaces the previous `volume_1h / (base_fee_pct / 100)` (audit finding M6),
 * which ignored the dynamic/volatility-aware fee tier, was ~1000× off live (a
 * $15.5k pool yielded ~18.9M), shifted with the fee tier, and wrongly rejected
 * good pools as "too active" (40/198 and 43/200 on the two recorded captures).
 */
export function getImpliedActiveTvl(pool: MeteoraPool): number {
  const tvl = getPoolTvl(pool);

  const fees = pool.fees || {};
  const fees1h = asNumber(fees['1h'] ?? fees['1H'], Number.NaN);
  const ratio1h = getFeeTvlRatio(pool, '1h');

  if (Number.isFinite(fees1h) && fees1h > 0 && Number.isFinite(ratio1h) && ratio1h > 0) {
    const derived = (fees1h * 100) / ratio1h;
    if (Number.isFinite(derived) && derived > 0) {
      // Consistency guard: beyond tolerance the payload is inconsistent, so use
      // the API's own `tvl` instead of the (suspect) derivation.
      if (tvl <= 0 || Math.abs(derived - tvl) <= tvl * IMPLIED_ACTIVE_TVL_TOLERANCE) {
        return derived;
      }
    }
  }

  return tvl;
}

/**
 * Is fees accelerating right now?
 * fee_1h > fee_2h / 2
 * Strong signal that activity is increasing (not a dead historical spike).
 */
export function isFeeAccelerating(pool: MeteoraPool): boolean {
  const fees = pool.fees || {};
  const fee1h = asNumber(fees['1h'] ?? fees['1H'], 0);
  const fee2h = asNumber(fees['2h'] ?? fees['2H'], 0);
  // Require at least a minimal recent fee floor (roughly 1h share of the daily min)
  // so brand-new pools with only 1h of history don't auto-pass the acceleration gate.
  const min1hFee = MIN_FEE_24H / 24;
  if (fee1h < min1hFee) return false;
  return fee1h > (fee2h / 2);
}

/**
 * Composite score for ranking deep-gate survivors before opening positions.
 *
 * Formula (using only real, already-populated fields):
 *   score = (feeTvlRatio_1h * LP_SCORE_FEE_TVL_1H_WEIGHT) +
 *           (feeTvlRatio_24h * LP_SCORE_FEE_TVL_24H_WEIGHT) +
 *           (lpCountNorm * LP_SCORE_LP_COUNT_WEIGHT)
 *
 * lpCountNorm = min(lpCount, LP_SCORE_LP_CAP) / LP_SCORE_LP_CAP
 * (default cap 20 so very large LP pools do not dominate; Claude suggested 50 if high-LP pools
 *  are consistently under-ranked — tune via LP_SCORE_LP_CAP env).
 *
 * Recent fee velocity (1h) gets the highest weight because it is the strongest signal
 * for fresh hot pools. lp_count acts as a quality / distribution sanity cap.
 *
 * Returns breakdown for observability in ranking logs.
 * Called only on candidates that have already passed every deep quality gate.
 */
export function computePoolScore(pool: MeteoraPool, lpCount: number) {
  const feeTvlRatio1h = getFeeTvlRatio(pool, '1h');
  const feeTvlRatio24h = getFeeTvlRatio(pool, '24h');
  const lpCountNorm = Math.min(Math.max(0, lpCount || 0), LP_SCORE_LP_CAP) / LP_SCORE_LP_CAP;

  const score =
    (feeTvlRatio1h * LP_SCORE_FEE_TVL_1H_WEIGHT) +
    (feeTvlRatio24h * LP_SCORE_FEE_TVL_24H_WEIGHT) +
    (lpCountNorm * LP_SCORE_LP_COUNT_WEIGHT);

  return {
    score,
    feeTvlRatio1h,
    feeTvlRatio24h,
    lpCountNorm,
  };
}

/**
 * Best-effort unique LP (position account) count for a pool.
 * Only called on the final ~top-5 survivors (expensive getProgramAccounts).
 *
 * Uses Helius when configured (preferred for speed + scale).
 * Returns 0 on any failure / no key / no matches (LP gate is soft-pass when unknown).
 */
export async function getUniqueLpCount(poolAddress: string): Promise<number> {
  const heliusUrl = getHeliusRpcEndpoint();

  if (!heliusUrl) {
    // No key or not configured — soft pass (consistent with previous behavior)
    return 0;
  }

  try {
    console.log(`[scanner][enrich] querying Helius getProgramAccounts for lp count on ${poolAddress}`);

    const response = await fetch(heliusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getProgramAccounts',
        params: [
          'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM program
          {
            encoding: 'base64',
            filters: [
              // NOTE: dataSize:1024 was too strict for many current DLMM position layouts.
              // We rely primarily on the memcmp for the pool pubkey at offset 8 (after 8-byte discriminator).
              // { dataSize: 1024 },
              {
                memcmp: {
                  offset: 8,
                  bytes: poolAddress,
                },
              },
            ],
          },
        ],
      }),
    });

    const json: any = await response.json();

    if (!response.ok || json?.error) {
      const errInfo = json?.error ? JSON.stringify(json.error) : `status ${response.status}`;
      console.warn(`[scanner] getUniqueLpCount Helius error for ${poolAddress}: ${errInfo}`);
      return 0;
    }

    const accounts = json?.result || [];
    const uniquePositions = new Set<string>();
    for (const acc of accounts) {
      if (acc?.pubkey) uniquePositions.add(acc.pubkey);
    }

    const count = uniquePositions.size;
    console.log(`[scanner][enrich] ${poolAddress} → ${count} position account(s) from Helius (raw accounts returned: ${accounts.length})`);

    return count;
  } catch (e) {
    console.warn(`[scanner] getUniqueLpCount Helius/RPC error for ${poolAddress}:`, e instanceof Error ? e.message : e);
    return 0;
  }
}

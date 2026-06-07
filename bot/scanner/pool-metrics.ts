/**
 * pool-metrics.ts
 *
 * Pool metric getters and derived proxies (per revised top-performer activity spec).
 *
 * - impliedActiveTVL = volume_1h / fee_pct   (proxy for real earning liquidity from swap flow)
 * - isFeeAccelerating = fee_1h > (fee_2h / 2)
 * - getUniqueLpCount (expensive, only on final survivors) via getProgramAccounts on DLMM program
 *
 * Current model uses only real fields from the /pools list API + derivations.
 * Legacy getters for non-returned fields (active_tvl etc.) are kept for compatibility.
 */

import type { MeteoraPool } from './pool-fetcher';
import { MIN_FEE_24H } from '@/lib/strategy-config';
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

export function getFeeTvlPct(pool: MeteoraPool, window: string): number {
  return getFeeTvlRatio(pool, window) * 100;
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

// ─── Legacy getters (for fields the current /pools API does not return) ───
// These were used in previous iterations that assumed active_tvl / lp_count fields existed.
// Current logic uses only real fields + the derived proxies below.

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
  if (f24 > 0 && f12 >= 0) {
    return f24 - f12;
  }
  return 0;
}

// ─── Current real API field proxies (per official docs + latest Claude recommendations) ───

/**
 * Implied active TVL from actual trading flow.
 * volume_1h / (base_fee_pct / 100)
 * This is one of the best available proxies for "real earning liquidity"
 * because it comes from swaps, not parked capital. Ghost pools die here.
 */
export function getImpliedActiveTvl(pool: MeteoraPool): number {
  const vol1h = getPoolVolume(pool, '1h');
  const poolConfig = pool.pool_config || {};
  const feePct = asNumber(poolConfig.base_fee_pct ?? (pool as any).base_fee_percentage, 0);
  if (feePct <= 0 || vol1h <= 0) return 0;
  return vol1h / (feePct / 100);
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

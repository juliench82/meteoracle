/**
 * lane-classifier.ts
 *
 * Lightweight lane classification + survivor selection + best-pool heuristics
 * for the ultra-simplified cb8c3dd architecture.
 *
 * Provides the exact symbols that deep-checker.ts calls after the refactor.
 * All heavy Supabase / live rebalance paths removed.
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
  scannerEarlyMaxAgeMinutes?: number;
  freshMaxAgeMinutes?: number;
  freshMinLiquidityUsd?: number;
  momentumPoolLimit?: number;
  momentumMinVolume5mUsd?: number;
  momentumMinFeeTvl5mPct?: number;
  scalpSpikeVolRatio?: number;
  maxFreshDeepChecks?: number;
  maxMomentumDeepChecks?: number;
};

type Survivor = {
  pool: MeteoraPool;
  mcUsd: number;
  ageHours: number;
  lane: 'fresh' | 'momentum';
};

export function classifyPoolsIntoLanes(pools: MeteoraPool[], config: LaneConfig = {}) {
  const freshMaxAgeMin = config.freshMaxAgeMinutes ?? 60;
  const freshMinLiq = config.freshMinLiquidityUsd ?? 20_000;
  const momVolMin = config.momentumMinVolume5mUsd ?? 1000;
  const momFeeMin = config.momentumMinFeeTvl5mPct ?? 0.5;

  const earlyAgePools: MeteoraPool[] = [];
  const momentumSpikePools: MeteoraPool[] = [];
  const momentumRegainPools: MeteoraPool[] = [];
  const freshPools: MeteoraPool[] = [];
  const momentumPools: MeteoraPool[] = [];

  let freshRejectedAge = 0;
  let freshRejectedLiquidity = 0;
  let momentumRejectedSpike = 0;

  for (const p of pools) {
    const ageMin = getPoolAgeMinutes(p);
    const liq = getPoolTvl(p);
    const vol5m = getPoolVolume(p, '5m');
    const fee5m = getFeeTvlPct(p, '5m');

    const isFresh = ageMin <= freshMaxAgeMin && liq >= freshMinLiq;
    const isMomentumSpike = vol5m >= momVolMin || fee5m >= momFeeMin;

    if (ageMin <= (config.scannerEarlyMaxAgeMinutes ?? 10)) {
      earlyAgePools.push(p);
    }

    if (isFresh) {
      freshPools.push(p);
      if (ageMin > freshMaxAgeMin) freshRejectedAge++;
      if (liq < freshMinLiq) freshRejectedLiquidity++;
    } else {
      if (ageMin <= freshMaxAgeMin) freshRejectedAge++;
      if (liq < freshMinLiq) freshRejectedLiquidity++;
    }

    if (isMomentumSpike) {
      momentumPools.push(p);
      momentumSpikePools.push(p);
    } else {
      momentumRejectedSpike++;
    }

    // Regain is conservative in simplified mode (real regain logic can be added later)
    if (!isFresh && !isMomentumSpike && ageMin < 240) {
      momentumRegainPools.push(p);
    }
  }

  // Survivors = the ones that passed their lane gates (simplified: all lane members are survivors for now)
  const freshSurvivors = freshPools.slice(0, config.maxFreshDeepChecks ?? 80);
  const momentumSurvivors = momentumPools.slice(0, config.maxMomentumDeepChecks ?? 40);

  const allSurvivors = [...freshSurvivors, ...momentumSurvivors];

  return {
    pools,
    earlyAgePools,
    momentumSpikePools,
    momentumRegainPools,
    freshPools,
    momentumPools,
    freshSurvivors,
    momentumSurvivors,
    allSurvivors,
    freshRejectedAge,
    freshRejectedLiquidity,
    momentumRejectedSpike,
  };
}

export function pickDeepCheckSurvivors(
  freshSurvivors: MeteoraPool[],
  momentumSurvivors: MeteoraPool[],
  recentlyClosedOorMints: Set<string>,
  config: LaneConfig = {}
): Survivor[] {
  const out: Survivor[] = [];
  const maxFresh = config.maxFreshDeepChecks ?? 80;
  const maxMom = config.maxMomentumDeepChecks ?? 40;

  for (const p of freshSurvivors) {
    if (out.length >= maxFresh) break;
    const trad = getTradableToken(p);
    const mint = trad?.address;
    if (mint && recentlyClosedOorMints.has(mint)) continue;
    const ageH = getPoolAgeMinutes(p) / 60;
    out.push({ pool: p, mcUsd: trad?.market_cap || 0, ageHours: ageH, lane: 'fresh' });
  }

  for (const p of momentumSurvivors) {
    if (out.length >= maxFresh + maxMom) break;
    const trad = getTradableToken(p);
    const mint = trad?.address;
    if (mint && recentlyClosedOorMints.has(mint)) continue;
    const ageH = getPoolAgeMinutes(p) / 60;
    out.push({ pool: p, mcUsd: trad?.market_cap || 0, ageHours: ageH, lane: 'momentum' });
  }

  return out;
}

export function survivorTokenAddress(s: Survivor | MeteoraPool | any): string {
  if (!s) return '';
  if (s.pool) {
    const t = getTradableToken(s.pool);
    return t?.address || '';
  }
  if ((s as any).token_x || (s as any).token_y) {
    const t = getTradableToken(s as MeteoraPool);
    return t?.address || '';
  }
  return s.mint || s.address || (s.pool && s.pool.address) || '';
}

export function selectBestPool(
  pools: MeteoraPool[] | any,
  tokenAddress: string,
  lane: string,
  rangeDownPct?: number,
  rangeUpPct?: number,
  maxBins?: number
) {
  const list: MeteoraPool[] = Array.isArray(pools) ? pools : [];
  // Prefer exact mint match on the tradable side
  let chosen = list.find((p: MeteoraPool) => {
    const t = getTradableToken(p);
    return t && t.address === tokenAddress;
  });

  if (!chosen && list.length > 0) {
    chosen = list[0];
  }

  // In simplified mode we report "preferred" only for illustration when bin_step is reasonable
  const binStep = chosen?.pool_config?.bin_step;
  const binCompat = binStep && binStep >= 10 && binStep <= 200 ? 0.85 : 0.55;

  return {
    pool: chosen || null,
    binStepPreferred: !!chosen && binCompat > 0.7,
    chosenBinCompatibility: binCompat,
    chosenBinStep: binStep,
    feeOnlyBinStep: binStep ? binStep + 10 : undefined,
    bestPossibleBinCompatibility: Math.min(0.95, binCompat + 0.1),
  };
}

export function passesMomentumRegain(pool: MeteoraPool | any): boolean {
  if (!pool) return false;
  // Simplified: treat a modest 5m fee/tvl or vol spike as "regain" signal
  const fee5m = getFeeTvlPct(pool, '5m') || 0;
  const vol5m = getPoolVolume(pool, '5m') || 0;
  return fee5m >= 1.5 || vol5m >= 3000;
}

export function getOneHourFeeTvlVs24hAverage(pool: MeteoraPool | any): number {
  if (!pool) return 1.0;
  const f1 = getFeeTvlPct(pool, '1h') || 0;
  const f24 = getFeeTvlPct(pool, '24h') || 0;
  if (f24 <= 0) return 1.0;
  return Math.max(0.1, Math.min(5, f1 / f24));
}

export function getOneHourVolumeVs24hAverage(pool: MeteoraPool | any): number {
  if (!pool) return 1.0;
  const v1 = getPoolVolume(pool, '1h') || 0;
  const v24 = getPoolVolume(pool, '24h') || 0;
  if (v24 <= 0) return 1.0;
  return Math.max(0.1, Math.min(5, v1 / v24));
}

// Kept for compatibility with any remaining direct references during transition
export const scalpSpikeStrategy = {
  id: 'scalp-spike',
  enabled: false,
  filters: {
    minMcUsd: 0,
    maxMcUsd: Infinity,
    minLiquidityUsd: 0,
    maxTopHolderPct: 100,
    minHolderCount: 0,
    maxAgeHours: 24,
    minRugcheckScore: 0,
    minFeeTvl24hPct: 0,
  },
} as any;

export function passesMomentumRegainStrategyFilters(metrics: any): boolean {
  // Conservative stub — the real one lives inside deep-checker as local fn
  return false;
}

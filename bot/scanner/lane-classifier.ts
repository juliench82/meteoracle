import { getPoolAgeMinutes, getPoolTvl, getPoolVolume, getFeeTvlPct, getVolumeTvlRatio, getRecentVolumeGrowth, scoreMeteoraMomentum, getTradableToken } from './pool-fetcher'

const SCALP_SPIKE_MOMENTUM_REGAIN = {
  minAgeHours: 0,
  maxAgeHours: 24,
  minVolumeTvl1hRatio: 0.5,
  minFeeTvl1hPct: 1,
}

const MOMENTUM_SPIKE_THRESHOLD = 2.5
const MOMENTUM_REGain_THRESHOLD = 1.5

export interface LaneClassifierConfig {
  scannerEarlyMaxAgeMinutes: number
  freshMaxAgeMinutes: number
  freshMinLiquidityUsd: number
  momentumPoolLimit: number
  momentumMinVolume5mUsd: number
  momentumMinFeeTvl5mPct: number
  scalpSpikeVolRatio: number
  maxFreshDeepChecks: number
  maxMomentumDeepChecks: number
}

export function classifyPoolsIntoLanes(pools: any[], config: LaneClassifierConfig) {
  const earlyAgePools: any[] = []
  const momentumSpikePools: any[] = []
  const momentumRegainPools: any[] = []
  const freshPools: any[] = []
  const momentumPools: any[] = []
  const freshSurvivors: any[] = []
  const momentumSurvivors: any[] = []
  const allSurvivors: any[] = []
  const freshRejectedAge: number[] = []
  const freshRejectedLiquidity: number[] = []
  const momentumRejectedSpike: number[] = []

  for (const pool of pools) {
    const ageHours = getPoolAgeMinutes(pool) / 60
    const liqUsd = getPoolTvl(pool)
    const vol5m = getPoolVolume(pool, '5m')
    const feeTvl5mPct = getFeeTvlPct(pool, '5m')
    const volumeTvl1hRatio = getVolumeTvlRatio(pool, '1h')
    const feeTvl1hPct = getFeeTvlPct(pool, '1h')

    if (ageHours < config.scannerEarlyMaxAgeMinutes / 60) {
      earlyAgePools.push(pool)
    }

    const isMomentumSpike = vol5m > 0 && liqUsd > 0 && (vol5m / liqUsd) >= config.scalpSpikeVolRatio
    if (isMomentumSpike) {
      momentumSpikePools.push(pool)
    }

    const isMomentumRegain = volumeTvl1hRatio >= SCALP_SPIKE_MOMENTUM_REGAIN.minVolumeTvl1hRatio &&
      feeTvl1hPct >= SCALP_SPIKE_MOMENTUM_REGAIN.minFeeTvl1hPct &&
      ageHours >= SCALP_SPIKE_MOMENTUM_REGAIN.minAgeHours &&
      ageHours <= SCALP_SPIKE_MOMENTUM_REGAIN.maxAgeHours

    if (isMomentumRegain) {
      momentumRegainPools.push(pool)
    }

    if (ageHours <= config.freshMaxAgeMinutes / 60 && liqUsd >= config.freshMinLiquidityUsd) {
      freshPools.push(pool)
    }

    if (vol5m >= config.momentumMinVolume5mUsd && feeTvl5mPct >= config.momentumMinFeeTvl5mPct) {
      momentumPools.push(pool)
    }

    if (ageHours <= config.freshMaxAgeMinutes / 60 && liqUsd >= config.freshMinLiquidityUsd) {
      freshSurvivors.push(pool)
    }

    if (vol5m >= config.momentumMinVolume5mUsd && feeTvl5mPct >= config.momentumMinFeeTvl5mPct) {
      momentumSurvivors.push(pool)
    }

    allSurvivors.push(pool)
  }

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
  }
}

export function getOneHourFeeTvlVs24hAverage(pool: any): number {
  const fee1h = getFeeTvlPct(pool, '1h')
  const fee24h = getFeeTvlPct(pool, '24h')
  return fee24h > 0 ? fee1h / fee24h : 0
}

export function getOneHourVolumeVs24hAverage(pool: any): number {
  const vol1h = getPoolVolume(pool, '1h')
  const vol24h = getPoolVolume(pool, '24h')
  return vol24h > 0 ? vol1h / vol24h : 0
}

export function passesMomentumRegain(pool: any): boolean {
  const ageHours = getPoolAgeMinutes(pool) / 60
  if (
    ageHours < SCALP_SPIKE_MOMENTUM_REGAIN.minAgeHours ||
    ageHours > SCALP_SPIKE_MOMENTUM_REGAIN.maxAgeHours
  ) {
    return false
  }
  const volumeTvl1hRatio = getVolumeTvlRatio(pool, '1h')
  const feeTvl1hPct = getFeeTvlPct(pool, '1h')
  return (
    volumeTvl1hRatio >= SCALP_SPIKE_MOMENTUM_REGAIN.minVolumeTvl1hRatio &&
    feeTvl1hPct >= SCALP_SPIKE_MOMENTUM_REGAIN.minFeeTvl1hPct
  )
}

export function pickDeepCheckSurvivors(
  freshSurvivors: any[],
  momentumSurvivors: any[],
  recentlyClosedOorMints: Set<string>,
  config: LaneClassifierConfig,
): any[] {
  const survivors: any[] = []
  const freshLimit = Math.min(config.maxFreshDeepChecks, freshSurvivors.length)
  const momentumLimit = Math.min(config.maxMomentumDeepChecks, momentumSurvivors.length)

  for (let i = 0; i < freshLimit; i++) {
    survivors.push({ pool: freshSurvivors[i], mcUsd: 0, ageHours: getPoolAgeMinutes(freshSurvivors[i]) / 60, lane: 'fresh' })
  }

  for (let i = 0; i < momentumLimit; i++) {
    survivors.push({ pool: momentumSurvivors[i], mcUsd: 0, ageHours: getPoolAgeMinutes(momentumSurvivors[i]) / 60, lane: 'momentum' })
  }

  return survivors
}

/**
 * Find the best pool for a given tradable token address within a lane's pool list.
 * Meteora pools store tokens as token_x and token_y — match on either side.
 *
 * When multiple pools exist for the same token (different bin_steps), we now prefer
 * pools whose bin_step would produce a "good" position width for the strategy's
 * desired range (closer to ideal without exceeding the strategy's max bins).
 *
 * Primary sort: highest feeTvl 1h (most active)
 * Secondary sort (when feeTvl is similar): best binStep compatibility with the range
 */
export function selectBestPool(
  pools: any[],
  tokenAddress: string,
  lane: string,
  rangeDownPct?: number,
  rangeUpPct?: number,
  maxBins?: number
): { 
  pool: any | null; 
  binStepPreferred: boolean;
  chosenBinStep?: number;
  feeOnlyBinStep?: number;
} {
  const matching = pools.filter(p =>
    p.token_x?.address === tokenAddress || p.token_y?.address === tokenAddress
  )

  if (matching.length === 0) return { pool: null, binStepPreferred: false, chosenBinStep: undefined, feeOnlyBinStep: undefined }
  if (matching.length === 1) return { pool: matching[0], binStepPreferred: false, chosenBinStep: matching[0]?.bin_step, feeOnlyBinStep: matching[0]?.bin_step }

  // Compute pure fee-based best for comparison
  const pureFeeBest = matching.reduce((best, p) =>
    (getFeeTvlPct(p, '1h') || 0) >= (getFeeTvlPct(best, '1h') || 0) ? p : best
  )

  // Score each pool
  const scored = matching.map(pool => {
    const feeScore = getFeeTvlPct(pool, '1h') || 0

    let binCompatibility = 0
    if (rangeDownPct !== undefined && rangeUpPct !== undefined && pool.bin_step) {
      const totalRange = Math.abs(rangeDownPct) + rangeUpPct
      const estimatedBins = Math.round((totalRange * 100) / (pool.bin_step / 100))

      if (maxBins && estimatedBins > maxBins) {
        binCompatibility = 0
      } else if (maxBins) {
        const closeness = 1 - Math.abs(estimatedBins - maxBins * 0.85) / (maxBins * 0.85)
        binCompatibility = Math.max(0, closeness)
      } else {
        binCompatibility = 0.5
      }
    }

    const score = feeScore * 10 + binCompatibility
    return { pool, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const chosen = scored[0].pool

  const binStepPreferred = chosen !== pureFeeBest

  return {
    pool: chosen,
    binStepPreferred,
    chosenBinStep: chosen?.bin_step,
    feeOnlyBinStep: pureFeeBest?.bin_step,
  }
}

/**
 * Returns the tradable token address (non-quote side) for a survivor entry.
 * Used for OOR recheck dedup — must match the mint stored in lp_positions.
 */
export function survivorTokenAddress(survivor: any): string {
  if (!survivor.pool) return ''
  try {
    return getTradableToken(survivor.pool)?.address ?? survivor.pool?.address ?? ''
  } catch {
    return survivor.pool?.address ?? ''
  }
}

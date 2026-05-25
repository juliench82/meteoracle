import { getPoolAgeMinutes, getPoolTvl, getPoolVolume, getFeeTvlPct, getVolumeTvlRatio, getRecentVolumeGrowth, scoreMeteoraMomentum, getTradableToken } from './pool-fetcher'

const SCALP_SPIKE_MOMENTUM_REGAIN = {
  minAgeHours: 0,
  maxAgeHours: 24,
  minVolumeTvl1hRatio: 0.5,
  minFeeTvl1hPct: 1,
}

const MOMENTUM_SPIKE_THRESHOLD = 2.5
const MOMENTUM_REGain_THRESHOLD = 1.5

// === selectBestPool tuning constants ===
const FEE_BIN_WEIGHT_FEE = 10
const TARGET_BIN_UTILIZATION = 0.85

// For Option B "stronger bin preference" logic:
// We are willing to accept a slightly worse fee pool if it has meaningfully better bin compatibility.
const BIN_COMPATIBILITY_FEE_TOLERANCE = 0.18 // 18% fee score tolerance
const BIN_COMPATIBILITY_MIN_IMPROVEMENT = 0.25 // bin score must be at least this much better

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
 * Selection strategy (Option B style):
 * - Primary: Highest fee_tvl_ratio_1h (most active trading).
 * - Stronger bin step preference: We are willing to accept a modestly lower fee pool
 *   if it offers significantly better bin compatibility for the target strategy range.
 * - We never hard-reject a token just because all pools have suboptimal bin steps.
 *
 * The 0.85 target utilization and fee/bin weights are defined as constants above.
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
  // Diagnostic fields (for logging / future visibility, no behavior change)
  chosenBinCompatibility?: number;
  chosenFeeScore?: number;
  bestPossibleBinCompatibility?: number;
} {
  const matching = pools.filter(p =>
    p.token_x?.address === tokenAddress || p.token_y?.address === tokenAddress
  )

  if (matching.length === 0) {
    console.log(`[scanner][select] ${tokenAddress} — no DLMM pools found for token in this lane's data`)
    return { pool: null, binStepPreferred: false, chosenBinStep: undefined, feeOnlyBinStep: undefined }
  }
  if (matching.length === 1) {
    const only = matching[0]
    console.log(`[scanner][select] ${tokenAddress} — only 1 DLMM pool (binStep=${only?.bin_step}) — auto-selected`)
    return { pool: only, binStepPreferred: false, chosenBinStep: only?.bin_step, feeOnlyBinStep: only?.bin_step }
  }

  // Multiple pools — this is where the interesting decisions happen
  console.log(`[scanner][select] ${tokenAddress} — ${matching.length} DLMM pools available for selection (lane=${lane})`)

  // Compute pure fee-based best for comparison
  const pureFeeBest = matching.reduce((best, p) =>
    (getFeeTvlPct(p, '1h') || 0) >= (getFeeTvlPct(best, '1h') || 0) ? p : best
  )

  // Score each pool (initial scoring)
  const scored = matching.map(pool => {
    let feeScore = getFeeTvlPct(pool, '1h') || 0

    // Light noise reduction for fresh tokens (WS2): blend with 5m to reduce pure 1h spikes
    if (lane === 'fresh') {
      const fee5m = getFeeTvlPct(pool, '5m') || 0
      feeScore = feeScore * 0.6 + fee5m * 0.4   // 60/40 blend as requested
    }

    let binCompatibility = 0
    if (rangeDownPct !== undefined && rangeUpPct !== undefined && pool.bin_step) {
      const totalRange = Math.abs(rangeDownPct) + rangeUpPct
      const estimatedBins = Math.round((totalRange * 100) / (pool.bin_step / 100))

      if (maxBins && estimatedBins > maxBins) {
        binCompatibility = 0
      } else if (maxBins) {
        const closeness = 1 - Math.abs(estimatedBins - maxBins * TARGET_BIN_UTILIZATION) / (maxBins * TARGET_BIN_UTILIZATION)
        binCompatibility = Math.max(0, closeness)
      } else {
        binCompatibility = 0.5
      }
    }

    const score = feeScore * FEE_BIN_WEIGHT_FEE + binCompatibility
    return { pool, score, feeScore, binCompatibility }
  })

  scored.sort((a, b) => b.score - a.score)

  // Log top candidates for visibility during dry-run
  const topForLog = scored.slice(0, 3).map(s => ({
    binStep: s.pool?.bin_step,
    fee: s.feeScore.toFixed(2),
    binComp: s.binCompatibility.toFixed(2),
    score: s.score.toFixed(1)
  }))
  console.log(`[scanner][select] ${tokenAddress} — top scored pools:`, JSON.stringify(topForLog))

  // === Option B: Stronger bin preference (deliberate boost) ===
  const bestFeePool = pureFeeBest
  const bestFeeScore = getFeeTvlPct(bestFeePool, '1h') || 0

  let chosen = scored[0]
  let optionBTriggered = false

  const competitivePools = scored.filter(item => {
    if (bestFeeScore <= 0) return false
    const relativeFeeDiff = Math.abs(item.feeScore - bestFeeScore) / bestFeeScore
    return relativeFeeDiff <= BIN_COMPATIBILITY_FEE_TOLERANCE
  })

  if (competitivePools.length > 0) {
    const bestBinAmongCompetitive = competitivePools.reduce((best, current) =>
      (current.binCompatibility > best.binCompatibility) ? current : best
    )

    if (bestBinAmongCompetitive.binCompatibility >= chosen.binCompatibility + BIN_COMPATIBILITY_MIN_IMPROVEMENT) {
      chosen = bestBinAmongCompetitive
      optionBTriggered = true
    }
  }

  if (optionBTriggered) {
    console.log(`[scanner][select] ${tokenAddress} — Option B triggered: switched to better bin pool (binComp=${chosen.binCompatibility.toFixed(2)}) within fee tolerance`)
  }

  const binStepPreferred = chosen.pool !== bestFeePool

  console.log(
    `[scanner][select] ${tokenAddress} — FINAL CHOICE: binStep=${chosen.pool?.bin_step} ` +
    `fee=${chosen.feeScore.toFixed(2)} binComp=${chosen.binCompatibility.toFixed(2)} ` +
    `binPreferred=${binStepPreferred}`
  )

  return {
    pool: chosen.pool,
    binStepPreferred,
    chosenBinStep: chosen.pool?.bin_step,
    feeOnlyBinStep: bestFeePool?.bin_step,
    chosenBinCompatibility: chosen.binCompatibility,
    chosenFeeScore: chosen.feeScore,
    bestPossibleBinCompatibility: Math.max(...scored.map(s => s.binCompatibility)),
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

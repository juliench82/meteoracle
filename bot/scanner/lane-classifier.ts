import { SCALP_SPIKE_MOMENTUM_REGAIN } from '@/strategies/scalp-spike'
import {
  QUOTE_ASSETS,
  getFeeTvlPct,
  getFeeTvlRatio,
  getPoolAgeMinutes,
  getPoolTvl,
  getPoolVolume,
  getTradableToken,
  scoreMeteoraMomentum,
  type MeteoraPool,
} from './pool-fetcher'

export type ScannerLane = 'fresh' | 'momentum'

export type LaneSurvivor = {
  pool: MeteoraPool
  mcUsd: number
  ageHours: number
  momentumScore: number
  lane: ScannerLane
}

export type LaneClassifierConfig = {
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

export type LaneClassificationResult = {
  pools: MeteoraPool[]
  earlyAgePools: MeteoraPool[]
  momentumRegainPools: MeteoraPool[]
  freshPools: MeteoraPool[]
  momentumPools: MeteoraPool[]
  freshSurvivors: LaneSurvivor[]
  momentumSurvivors: LaneSurvivor[]
  allSurvivors: LaneSurvivor[]
  freshRejectedAge: number
  freshRejectedLiquidity: number
  momentumRejectedSpike: number
}

const POOL_MIN_TVL_USD = 20_000
const BIN_STEP_SCORE: Record<number, number> = { 50: 4, 100: 3, 200: 2, 300: 1 }

export function getFiveMinuteVolumeSpike(pool: MeteoraPool): number {
  const volume5m = getPoolVolume(pool, '5m')
  const volume1h = getPoolVolume(pool, '1h')
  const oneHourPerFiveMinutes = volume1h / 12
  return oneHourPerFiveMinutes > 0 ? volume5m / oneHourPerFiveMinutes : 0
}

export function getOneHourVolumeVs24hAverage(pool: MeteoraPool): number {
  const volume24hAvg = getPoolVolume(pool, '24h') / 24
  if (volume24hAvg <= 0) return getPoolVolume(pool, '1h') > 0 ? Number.POSITIVE_INFINITY : 0
  return getPoolVolume(pool, '1h') / volume24hAvg
}

export function getOneHourFeeTvlVs24hAverage(pool: MeteoraPool): number {
  const feeTvl24hAvg = getFeeTvlPct(pool, '24h') / 24
  if (feeTvl24hAvg <= 0) return getFeeTvlPct(pool, '1h') > 0 ? Number.POSITIVE_INFINITY : 0
  return getFeeTvlPct(pool, '1h') / feeTvl24hAvg
}

export function passesMomentumRegain(pool: MeteoraPool): boolean {
  const ageHours = getPoolAgeMinutes(pool) / 60
  if (
    ageHours < SCALP_SPIKE_MOMENTUM_REGAIN.minAgeHours ||
    ageHours > SCALP_SPIKE_MOMENTUM_REGAIN.maxAgeHours
  ) {
    return false
  }

  const volumeRegain =
    getPoolVolume(pool, '1h') >= SCALP_SPIKE_MOMENTUM_REGAIN.minVolume1hUsd &&
    getOneHourVolumeVs24hAverage(pool) >= SCALP_SPIKE_MOMENTUM_REGAIN.minVolume1hTo24hAvgRatio
  const feeRegain =
    getFeeTvlPct(pool, '1h') >= SCALP_SPIKE_MOMENTUM_REGAIN.minFeeTvl1hPct &&
    getOneHourFeeTvlVs24hAverage(pool) >= SCALP_SPIKE_MOMENTUM_REGAIN.minFeeTvl1hTo24hAvgRatio

  return volumeRegain || feeRegain
}

export function passesMomentumSpike(pool: MeteoraPool, config: LaneClassifierConfig): boolean {
  return (
    getPoolVolume(pool, '5m') >= config.momentumMinVolume5mUsd &&
    getFiveMinuteVolumeSpike(pool) >= config.scalpSpikeVolRatio &&
    getFeeTvlPct(pool, '5m') >= config.momentumMinFeeTvl5mPct
  )
}

export function passesMomentumLane(pool: MeteoraPool, config: LaneClassifierConfig): boolean {
  return passesMomentumSpike(pool, config) || passesMomentumRegain(pool)
}

export function survivorTokenAddress(item: { pool: MeteoraPool }): string {
  return getTradableToken(item.pool).address
}

function pushBestSurvivor(
  map: Map<string, LaneSurvivor>,
  pool: MeteoraPool,
  lane: ScannerLane,
  momentumScore: number,
): void {
  const token = getTradableToken(pool)
  const existing = map.get(token.address)
  if (!existing || momentumScore > existing.momentumScore) {
    map.set(token.address, {
      pool,
      mcUsd: token.market_cap ?? 0,
      ageHours: getPoolAgeMinutes(pool) / 60,
      momentumScore,
      lane,
    })
  }
}

export function selectBestPool(
  allPools: MeteoraPool[],
  mintAddress: string,
  lane: ScannerLane = 'fresh',
): MeteoraPool | null {
  const candidates = allPools.filter(pool => {
    if (pool.is_blacklisted) return false
    if (getPoolTvl(pool) < POOL_MIN_TVL_USD) return false
    const hasMint = pool.token_x.address === mintAddress || pool.token_y.address === mintAddress
    if (!hasMint) return false
    const hasQuote = QUOTE_ASSETS.has(pool.token_x.address) || QUOTE_ASSETS.has(pool.token_y.address)
    return hasQuote
  })

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const feeWindow = lane === 'momentum' ? '5m' : '24h'
  const maxFeeTvl = Math.max(...candidates.map(pool => getFeeTvlRatio(pool, feeWindow)))
  let best: MeteoraPool | null = null
  let bestScore = -Infinity

  for (const pool of candidates) {
    const feeTvlNorm = maxFeeTvl > 0 ? (getFeeTvlRatio(pool, feeWindow) / maxFeeTvl) * 10 : 0
    const binStep = pool.pool_config?.bin_step ?? 999
    const binStepBonus = BIN_STEP_SCORE[binStep] ?? 0
    const score = feeTvlNorm + binStepBonus + scoreMeteoraMomentum(pool)
    if (score > bestScore) { bestScore = score; best = pool }
  }

  return best
}

export function classifyPoolsIntoLanes(
  fetchedPools: MeteoraPool[],
  config: LaneClassifierConfig,
): LaneClassificationResult {
  const earlyAgePools = fetchedPools.filter(pool => getPoolAgeMinutes(pool) <= config.scannerEarlyMaxAgeMinutes)
  const momentumRegainPools = fetchedPools.filter(passesMomentumRegain)
  const pools = Array.from(
    new Map([...earlyAgePools, ...momentumRegainPools].map(pool => [pool.address, pool])).values(),
  )

  const freshPools = pools.filter(pool => getPoolAgeMinutes(pool) <= config.freshMaxAgeMinutes)
  const momentumPools = pools
    .filter(pool => !pool.is_blacklisted)
    .filter(pool => passesMomentumLane(pool, config))
    .sort((a, b) => scoreMeteoraMomentum(b) - scoreMeteoraMomentum(a))
    .slice(0, config.momentumPoolLimit)

  const freshBestMap = new Map<string, LaneSurvivor>()
  const momentumBestMap = new Map<string, LaneSurvivor>()
  let freshRejectedAge = 0
  let freshRejectedLiquidity = 0
  let momentumRejectedSpike = 0

  for (const pool of freshPools) {
    const token = getTradableToken(pool)
    const liqUsd = getPoolTvl(pool)
    const ageMinutes = getPoolAgeMinutes(pool)

    if (ageMinutes > config.freshMaxAgeMinutes) {
      freshRejectedAge++
      console.log(`[scanner] REJECT - ${pool.name ?? token.symbol} is ${ageMinutes.toFixed(1)}min old (max ${config.freshMaxAgeMinutes}min)`)
      continue
    }
    if (liqUsd < config.freshMinLiquidityUsd) {
      freshRejectedLiquidity++
      continue
    }

    pushBestSurvivor(freshBestMap, pool, 'fresh', scoreMeteoraMomentum(pool))
  }

  for (const pool of momentumPools) {
    const liqUsd = getPoolTvl(pool)
    if (liqUsd < 30_000) continue
    if (!passesMomentumLane(pool, config)) {
      momentumRejectedSpike++
      continue
    }
    pushBestSurvivor(momentumBestMap, pool, 'momentum', scoreMeteoraMomentum(pool))
  }

  const freshSurvivors = Array.from(freshBestMap.values()).sort((a, b) => b.momentumScore - a.momentumScore)
  const momentumSurvivors = Array.from(momentumBestMap.values()).sort((a, b) => {
    const volumeDiff = getPoolVolume(b.pool, '5m') - getPoolVolume(a.pool, '5m')
    return volumeDiff !== 0 ? volumeDiff : b.momentumScore - a.momentumScore
  })
  const allSurvivors = [...freshSurvivors, ...momentumSurvivors]

  return {
    pools,
    earlyAgePools,
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

export function pickDeepCheckSurvivors(
  freshSurvivors: LaneSurvivor[],
  momentumSurvivors: LaneSurvivor[],
  recentlyClosedOorMints: Set<string>,
  config: LaneClassifierConfig,
): LaneSurvivor[] {
  const pickLaneSurvivors = (laneSurvivors: LaneSurvivor[], maxDeepChecks: number): LaneSurvivor[] => {
    const priority = laneSurvivors.filter(item => recentlyClosedOorMints.has(survivorTokenAddress(item)))
    const priorityMintSet = new Set(priority.map(survivorTokenAddress))
    const ranked = laneSurvivors.filter(item => !priorityMintSet.has(survivorTokenAddress(item)))
    return [
      ...priority,
      ...ranked.slice(0, Math.max(0, maxDeepChecks - priority.length)),
    ]
  }

  return [
    ...pickLaneSurvivors(freshSurvivors, config.maxFreshDeepChecks),
    ...pickLaneSurvivors(momentumSurvivors, config.maxMomentumDeepChecks),
  ]
}

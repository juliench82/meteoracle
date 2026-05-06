import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true, quiet: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { getStrategyForToken, classifyToken, explainNoStrategy } from '@/strategies'
import { scoreCandidateWithBreakdown } from '../scorer'
import { openPosition } from '../executor'
import { sendAlert } from '../alerter'
import { checkHolders } from '@/lib/helius'
import { getRugscore, getRugcheckCacheSize } from '../rugcheck-cache'
import {
  fetchBondingCurve,
  isPumpFunToken,
  isMoonshotToken,
} from '@/lib/pumpfun'
import type { TokenMetrics } from '@/lib/types'
import { evaluateDammEdge } from '@/strategies/damm-edge'
import { EVIL_PANDA_SCANNER_SCORE_WEIGHTS } from '@/strategies/evil-panda'
import { scalpSpikeStrategy } from '@/strategies/scalp-spike'
import { openDammPosition, resolveVerifiedDammV2PoolForToken } from '../damm-executor'
import { OPEN_LP_STATUSES, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { getHeliusRpcEndpoint } from '@/lib/solana'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import { isDailyLossLimitHit } from '@/lib/circuit-breaker'
import {
  WSOL,
  fetchMeteoraPools,
  getFeeTvlPct,
  getPoolAgeMinutes,
  getPoolTvl,
  getPoolVolume,
  getQuoteTokenMint,
  getRecentVolumeGrowth,
  getTradableToken,
  getVolumeTvlRatio,
  scoreMeteoraMomentum,
} from './pool-fetcher'
import {
  classifyPoolsIntoLanes,
  getOneHourFeeTvlVs24hAverage,
  getOneHourVolumeVs24hAverage,
  passesMomentumRegain,
  pickDeepCheckSurvivors,
  selectBestPool,
  survivorTokenAddress,
} from './lane-classifier'

const DEXSCREENER     = 'https://api.dexscreener.com/latest/dex/tokens'

const PRE_FILTER = {
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 500_000_000,
}

const MAX_DEEP_CHECKS          = parseInt(process.env.MAX_DEEP_CHECKS          ?? '6')
const DEEP_CHECK_DELAY_MS      = parseInt(process.env.DEEP_CHECK_DELAY_MS      ?? '3000')

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '65')
export const MAX_CONCURRENT_MARKET_LP_POSITIONS = parseInt(
  process.env.MAX_CONCURRENT_MARKET_LP_POSITIONS ?? process.env.MAX_CONCURRENT_POSITIONS ?? '5',
)
const MAX_CONCURRENT_DAMM_POSITIONS = parseInt(process.env.MAX_CONCURRENT_DAMM_POSITIONS ?? '2', 10)
const MARKET_LP_SOL_PER_POSITION = parseFloat(
  process.env.MAX_MARKET_LP_SOL_PER_POSITION ??
  process.env.MARKET_LP_SOL_PER_POSITION ??
  process.env.MAX_SOL_PER_POSITION ??
  '0.1',
)
const SCALP_SPIKE_ENABLED = process.env.SCALP_SPIKE_ENABLED === 'true'
const EVIL_PANDA_ENABLED = process.env.EVIL_PANDA_ENABLED === 'true'
const LP_SCANNER_ENABLED = process.env.LP_SCANNER_ENABLED !== 'false' &&
  process.env.SCANNER_ENABLED !== 'false'
export const SCAN_INTERVAL_MS         = parseInt(process.env.LP_SCAN_INTERVAL_SEC     ?? '900') * 1_000
const DEFAULT_SCANNER_TICK_TIMEOUT_MS = Math.max(60_000, SCAN_INTERVAL_MS - 30_000)
const CONFIGURED_SCANNER_TICK_TIMEOUT_MS = parseInt(
  process.env.LP_SCANNER_TICK_TIMEOUT_MS ??
  process.env.SCANNER_TICK_TIMEOUT_MS ??
  String(DEFAULT_SCANNER_TICK_TIMEOUT_MS),
  10,
)
const SCANNER_TICK_TIMEOUT_MS = Number.isFinite(CONFIGURED_SCANNER_TICK_TIMEOUT_MS)
  ? Math.max(60_000, CONFIGURED_SCANNER_TICK_TIMEOUT_MS)
  : DEFAULT_SCANNER_TICK_TIMEOUT_MS
const CANDIDATE_DEDUP_HOURS    = parseFloat(process.env.CANDIDATE_DEDUP_HOURS  ?? '0')
const OOR_RECHECK_HOURS        = parseInt(process.env.OOR_RECHECK_HOURS        ?? '24')
const HARD_MAX_TOKEN_AGE_MINUTES = parseInt(process.env.HARD_MAX_TOKEN_AGE_MINUTES ?? '120')
const SCANNER_EARLY_MAX_AGE_MINUTES = parseInt(process.env.SCANNER_EARLY_MAX_AGE_MINUTES ?? '90', 10)
const FRESH_MAX_AGE_MINUTES    = Math.min(
  parseInt(process.env.FRESH_SCANNER_MAX_AGE_MINUTES ?? `${HARD_MAX_TOKEN_AGE_MINUTES}`),
  SCANNER_EARLY_MAX_AGE_MINUTES,
)
const FRESH_MIN_LIQUIDITY_USD  = parseFloat(process.env.FRESH_MIN_LIQUIDITY_USD ?? process.env.EVIL_PANDA_MIN_LIQUIDITY_USD ?? '20000')
const MOMENTUM_MIN_VOLUME_5M_USD = parseFloat(process.env.MOMENTUM_MIN_VOLUME_5M_USD ?? '5000')
const MOMENTUM_POOL_LIMIT      = parseInt(process.env.MOMENTUM_POOL_LIMIT ?? '500')
const MOMENTUM_MIN_FEE_TVL_5M_PCT = parseFloat(process.env.MOMENTUM_MIN_FEE_TVL_5M_PCT ?? process.env.SCALP_SPIKE_MIN_FEE_TVL_5M_PCT ?? '0.1')
const SCALP_SPIKE_VOL_RATIO    = parseFloat(process.env.SCALP_SPIKE_VOL_RATIO ?? '2.5')
const MAX_FRESH_DEEP_CHECKS    = parseInt(process.env.MAX_FRESH_DEEP_CHECKS ?? `${MAX_DEEP_CHECKS}`)
const MAX_MOMENTUM_DEEP_CHECKS = parseInt(process.env.MAX_MOMENTUM_DEEP_CHECKS ?? `${MAX_DEEP_CHECKS}`)

const METEORA_FILTERED_FETCH = {
  minTvlUsd: parseFloat(process.env.METEORA_MIN_TVL_USD ?? '8000'),
  minFeeTvlRatio1h: parseFloat(process.env.METEORA_MIN_FEE_TVL_RATIO_1H ?? '0.001'),
  minVolumeTvl1hRatio: parseFloat(process.env.METEORA_MIN_VOLUME_TVL_1H_RATIO ?? '0.20'),
  limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '800'),
}

// Strict 15-min gate for new Meteora listings (0.25h)
const METEORA_NEW_LISTING_AGE_H   = 0.25
const METEORA_NEW_LISTING_LIQ_USD = 25_000
const METEORA_NEW_LISTING_FEETVL  = 8   // %

const SUPABASE_TIMEOUT_MS      = 10_000
const METEORA_FETCH_TIMEOUT_MS = 45_000
const USE_HELIUS               = process.env.HELIUS_ENABLED === 'true'

const _bondingCurveCache = new Map<string, { pct: number; complete: boolean | null; ts: number }>()
const BONDING_CACHE_TTL_MS = 10 * 60 * 1_000

type CachedBondingCurve = {
  progressPct: number
  complete: boolean | null
}

// Thresholds for high-curve detection (logged, falls through to normal scoring)
const PUMPFUN_HIGHCURVE_THRESHOLD  = 95

export type ScannerResult = {
  scanned: number
  survivors: number
  deepChecked: number
  candidates: number
  opened: number
  openSkipped: number
  openSlots: number
  maxOpen: number
  openCount?: number
  openBlockedReason?: string
  error?: string
}

function detectLaunchpadSource(tokenAddress: string): 'pumpfun' | 'moonshot' | 'meteora' {
  if (isPumpFunToken(tokenAddress)) return 'pumpfun'
  if (isMoonshotToken(tokenAddress)) return 'moonshot'
  return 'meteora'
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T | null> {
  let timerId: ReturnType<typeof setTimeout>
  const timer = new Promise<null>((resolve) => {
    timerId = setTimeout(() => {
      console.warn(`[scanner] timeout (${ms}ms): ${label}`)
      resolve(null)
    }, ms)
  })
  const result = await Promise.race([Promise.resolve(promise), timer])
  clearTimeout(timerId!)
  return result
}

export async function logScannerTick(result: ScannerResult, durationMs: number, source = 'scanner'): Promise<void> {
  try {
    const insertResult = await withTimeout(
      createServerClient().from('bot_logs').insert({
        level: result.error ? 'error' : 'info',
        event: result.error ? 'scanner_tick_failed' : 'scanner_tick',
        payload: { ...result, durationMs, source },
      }),
      SUPABASE_TIMEOUT_MS,
      'bot_logs insert scanner_tick',
    )
    if (insertResult && 'error' in insertResult && insertResult.error) {
      console.warn('[scanner] bot_logs insert failed:', insertResult.error.message)
    }
  } catch (err) {
    console.warn('[scanner] bot_logs insert failed:', err)
  }
}

export async function writeScannerHeartbeat(source: 'interval' | 'startup' = 'interval'): Promise<void> {
  try {
    const nowIso = new Date().toISOString()
    const payload: Record<string, unknown> = {
      service: 'scanner',
      last_scan_at: nowIso,
      metadata: {
        source,
      },
    }
    const upsertResult = await withTimeout(
      createServerClient()
        .from('bot_health')
        .upsert(payload, { onConflict: 'service' }),
      SUPABASE_TIMEOUT_MS,
      'bot_health upsert scanner',
    )
    if (upsertResult && 'error' in upsertResult && upsertResult.error) {
      console.warn('[scanner] bot_health upsert failed:', upsertResult.error.message)
    }
  } catch (err) {
    console.warn('[scanner] bot_health upsert failed:', err)
  }
}

async function getCachedPumpFunBondingCurve(
  tokenAddress: string,
  heliusRpcUrl: string,
): Promise<CachedBondingCurve | null> {
  const cached = _bondingCurveCache.get(tokenAddress)
  if (cached && Date.now() - cached.ts < BONDING_CACHE_TTL_MS) {
    return { progressPct: cached.pct, complete: cached.complete }
  }

  const curve = await fetchBondingCurve(tokenAddress, heliusRpcUrl)
  if (!curve) return null

  _bondingCurveCache.set(tokenAddress, {
    pct: curve.progressPct,
    complete: curve.complete,
    ts: Date.now(),
  })
  return { progressPct: curve.progressPct, complete: curve.complete }
}

function findLiveOpenPosition(
  limitState: OpenLpLimitState | null,
  tokenAddress: string,
  poolAddress?: string,
) {
  return limitState?.livePositions.find(position =>
    position.mint === tokenAddress ||
    (!!poolAddress && position.pool_address === poolAddress),
  ) ?? null
}

function getDisabledStrategyReason(strategyId: string): string | null {
  if (strategyId === 'scalp-spike' && !SCALP_SPIKE_ENABLED) return 'SCALP_SPIKE_ENABLED is not true'
  if (strategyId === 'evil-panda' && !EVIL_PANDA_ENABLED) return 'EVIL_PANDA_ENABLED is not true'
  return null
}

function getOpenDammEdgeCount(limitState: OpenLpLimitState | null): number {
  return limitState?.livePositions.filter(position =>
    position.position_type === 'damm-edge' || position.strategy_id === 'damm-edge',
  ).length ?? 0
}

function scoreFeeTvl1hPct(pct: number): number {
  if (pct >= 8) return 100
  if (pct >= 5) return 85
  if (pct >= 3) return 65
  if (pct >= 1.5) return 40
  if (pct >= 0.5) return 20
  return 0
}

function scoreVolumeTvl1hRatio(ratio: number): number {
  if (ratio >= 1.5) return 100
  if (ratio >= 1.0) return 90
  if (ratio >= 0.5) return 75
  if (ratio >= 0.2) return 55
  if (ratio >= 0.1) return 30
  return 0
}

function scoreHolderCount(holderCount: number): number {
  if (holderCount >= 5000) return 100
  if (holderCount >= 2000) return 80
  if (holderCount >= 1000) return 65
  if (holderCount >= 500) return 45
  if (holderCount >= 200) return 25
  return 10
}

function getMomentumRegainBreakdown(
  metrics: TokenMetrics,
): ReturnType<typeof scoreCandidateWithBreakdown> {
  const rugScore = Math.max(0, Math.min(100, metrics.rugcheckScore))
  const holderScore = scoreHolderCount(metrics.holderCount)
  const feeEfficiencyScore = scoreFeeTvl1hPct(metrics.feeTvl1hPct ?? 0)
  const volumeTvlScore = scoreVolumeTvl1hRatio(metrics.volumeTvl1hRatio ?? 0)
  const freshnessScore =
    metrics.ageHours <= 6 ? 100 :
    metrics.ageHours <= 12 ? 85 :
    metrics.ageHours <= 24 ? 70 :
    55
  const total = Math.round(
    Math.min(
      100,
      feeEfficiencyScore * 0.35 +
      volumeTvlScore * 0.35 +
      rugScore * 0.15 +
      holderScore * 0.10 +
      freshnessScore * 0.05,
    ),
  )

  return {
    total,
    volMcScore: 0,
    rugScore,
    holderScore,
    freshnessScore,
    feeEfficiencyScore,
    volumeTvlScore,
    curveBonus: 0,
  }
}

function getScannerAdjustedScore(
  metrics: TokenMetrics,
  strategyId: string,
  breakdown: ReturnType<typeof scoreCandidateWithBreakdown>,
): number {
  if (strategyId !== 'evil-panda') return breakdown.total

  const weights = EVIL_PANDA_SCANNER_SCORE_WEIGHTS
  const totalWeight =
    weights.freshness +
    weights.rugcheck +
    weights.holders +
    weights.feeTvl1h +
    weights.volumeTvl1h

  if (totalWeight <= 0) return breakdown.total

  const feeTvl1hScore = scoreFeeTvl1hPct(metrics.feeTvl1hPct ?? 0)
  const volumeTvl1hScore = scoreVolumeTvl1hRatio(metrics.volumeTvl1hRatio ?? 0)
  const weighted =
    (breakdown.freshnessScore * weights.freshness +
      breakdown.rugScore * weights.rugcheck +
      breakdown.holderScore * weights.holders +
      feeTvl1hScore * weights.feeTvl1h +
      volumeTvl1hScore * weights.volumeTvl1h) / totalWeight

  const total = Math.round(Math.min(100, Math.max(0, weighted + breakdown.curveBonus)))
  console.log(
    `[scanner] ${metrics.symbol} — evil-panda weighted score ` +
    `fee1h=${feeTvl1hScore} volTvl1h=${volumeTvl1hScore} raw=${breakdown.total} → ${total}`,
  )
  return total
}

function passesMomentumRegainStrategyFilters(metrics: TokenMetrics): boolean {
  const f = scalpSpikeStrategy.filters
  return (
    scalpSpikeStrategy.enabled &&
    metrics.mcUsd >= f.minMcUsd &&
    metrics.mcUsd <= f.maxMcUsd &&
    metrics.liquidityUsd >= f.minLiquidityUsd &&
    metrics.topHolderPct <= f.maxTopHolderPct &&
    metrics.holderCount >= f.minHolderCount &&
    metrics.ageHours <= f.maxAgeHours &&
    metrics.rugcheckScore >= f.minRugcheckScore &&
    metrics.feeTvl24hPct >= f.minFeeTvl24hPct
  )
}

async function fetchRecentlyClosedOorMints(supabase: ReturnType<typeof createServerClient>): Promise<Set<string>> {
  if (OOR_RECHECK_HOURS <= 0) return new Set()

  const result = await withTimeout(
    supabase
      .from('lp_positions')
      .select('mint, symbol, closed_at, close_reason')
      .eq('status', 'closed')
      .gte('closed_at', new Date(Date.now() - OOR_RECHECK_HOURS * 3_600_000).toISOString())
      .order('closed_at', { ascending: false })
      .limit(50),
    SUPABASE_TIMEOUT_MS,
    'recent OOR recheck rows',
  )

  if (!result || ('error' in result && result.error)) {
    const message = result && 'error' in result ? result.error?.message : 'timeout'
    console.warn(`[scanner] recent OOR recheck lookup failed: ${message}`)
    return new Set()
  }

  const rows = 'data' in result ? (result.data ?? []) : []
  return new Set(
    rows
      .filter((row: { mint?: string | null; close_reason?: string | null }) =>
        Boolean(row.mint) && String(row.close_reason ?? '').startsWith('out_of_range_'),
      )
      .map((row: { mint: string }) => row.mint),
  )
}

let scannerRunPromise: Promise<ScannerResult> | null = null
let scannerRunStartedAt = 0

function emptyScannerResult(result: Partial<ScannerResult>): ScannerResult {
  return {
    scanned: 0,
    survivors: 0,
    deepChecked: 0,
    candidates: 0,
    opened: 0,
    openSkipped: 0,
    openSlots: 0,
    maxOpen: MAX_CONCURRENT_MARKET_LP_POSITIONS,
    ...result,
  }
}

export async function runScanner(): Promise<ScannerResult> {
  if (scannerRunPromise) {
    const ageMs = Date.now() - scannerRunStartedAt
    console.warn(`[scanner] previous tick still running (${Math.round(ageMs / 1000)}s) — skipping overlapping tick`)
    return emptyScannerResult({
      openBlockedReason: ageMs > SCANNER_TICK_TIMEOUT_MS ? 'scanner_tick_watchdog_active' : 'scanner_tick_in_flight',
    })
  }

  scannerRunStartedAt = Date.now()
  const run = runScannerOnce().finally(() => {
    if (scannerRunPromise === run) {
      scannerRunPromise = null
      scannerRunStartedAt = 0
    }
  })
  scannerRunPromise = run

  const timeout = new Promise<ScannerResult>((resolve) => {
    const timer = setTimeout(() => {
      const durationMs = Date.now() - scannerRunStartedAt
      const result = emptyScannerResult({
        openBlockedReason: 'scanner_tick_timeout',
        error: `scanner tick exceeded ${SCANNER_TICK_TIMEOUT_MS}ms watchdog`,
      })
      console.error(`[scanner] watchdog timeout after ${Math.round(durationMs / 1000)}s — leaving in-flight guard active until the tick settles`)
      void logScannerTick(result, durationMs, 'scanner-watchdog').finally(() => resolve(result))
    }, SCANNER_TICK_TIMEOUT_MS)

    run.finally(() => clearTimeout(timer)).catch(() => {})
  })

  return Promise.race([run, timeout])
}

async function runScannerOnce(): Promise<ScannerResult> {
  const startedAt = Date.now()
  const finish = async (result: Partial<ScannerResult>): Promise<ScannerResult> => {
    const fullResult = emptyScannerResult(result)
    await logScannerTick(fullResult, Date.now() - startedAt)
    return fullResult
  }

  if (!LP_SCANNER_ENABLED) {
    console.log('[scanner] disabled — LP_SCANNER_ENABLED=false')
    return finish({ openBlockedReason: 'scanner_disabled' })
  }

  const state = await getBotState()
  if (!state.enabled) {
    console.log('[scanner] bot is stopped — skipping tick')
    return finish({ openBlockedReason: 'bot_stopped' })
  }

  await refreshRpcProviderCooldown('helius')

  console.log('[scanner] step 1/4 — fetching Meteora pools')
  const laneConfig = {
    scannerEarlyMaxAgeMinutes: SCANNER_EARLY_MAX_AGE_MINUTES,
    freshMaxAgeMinutes: FRESH_MAX_AGE_MINUTES,
    freshMinLiquidityUsd: FRESH_MIN_LIQUIDITY_USD,
    momentumPoolLimit: MOMENTUM_POOL_LIMIT,
    momentumMinVolume5mUsd: MOMENTUM_MIN_VOLUME_5M_USD,
    momentumMinFeeTvl5mPct: MOMENTUM_MIN_FEE_TVL_5M_PCT,
    scalpSpikeVolRatio: SCALP_SPIKE_VOL_RATIO,
    maxFreshDeepChecks: MAX_FRESH_DEEP_CHECKS,
    maxMomentumDeepChecks: MAX_MOMENTUM_DEEP_CHECKS,
  }
  const { pools: fetchedPools, error: fetchError } = await fetchMeteoraPools({
    ...METEORA_FILTERED_FETCH,
    timeoutMs: METEORA_FETCH_TIMEOUT_MS,
    freshMaxAgeMinutes: FRESH_MAX_AGE_MINUTES,
    freshMinLiquidityUsd: FRESH_MIN_LIQUIDITY_USD,
    minLiquidityUsd: PRE_FILTER.minLiquidityUsd,
    maxLiquidityUsd: PRE_FILTER.maxLiquidityUsd,
    momentumMinVolume5mUsd: MOMENTUM_MIN_VOLUME_5M_USD,
    isMomentumRegain: passesMomentumRegain,
  })
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return finish({ error: fetchError, openBlockedReason: 'pool_fetch_failed' })
  }

  const {
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
  } = classifyPoolsIntoLanes(fetchedPools, laneConfig)

  console.log(`[scanner] step 1/4 — got ${pools.length} pools`)
  console.log(
    `[scanner] early age gate — kept ${earlyAgePools.length}/${fetchedPools.length} ` +
    `<=${SCANNER_EARLY_MAX_AGE_MINUTES}min + ${momentumRegainPools.length} momentum-regain exception(s)`,
  )

  console.log(
    `[scanner] lanes — fresh=${freshPools.length}/${pools.length} <=${FRESH_MAX_AGE_MINUTES}min, ` +
    `momentum=${momentumPools.length}/${pools.length} spike/regain candidates`,
  )

  console.log('[scanner] step 2/4 — lane pre-screen')
  console.log(
    `[scanner] step 2/4 — fresh survivors=${freshSurvivors.length} ` +
    `(ageRejected=${freshRejectedAge}, liquidityRejected=${freshRejectedLiquidity}); ` +
    `momentum survivors=${momentumSurvivors.length} (spikeRejected=${momentumRejectedSpike})`,
  )

  if (allSurvivors.length === 0) {
    console.log('[scanner] done — no lane survivors')
    return finish({ scanned: pools.length, survivors: 0 })
  }

  const supabase = createServerClient()
  const recentlyClosedOorMints = await fetchRecentlyClosedOorMints(supabase)
  const survivors = pickDeepCheckSurvivors(freshSurvivors, momentumSurvivors, recentlyClosedOorMints, laneConfig)

  if (recentlyClosedOorMints.size > 0) {
    const queuedMints = new Set(survivors.map(survivorTokenAddress))
    const missed = Array.from(recentlyClosedOorMints).filter(mint => !queuedMints.has(mint))
    console.log(
      `[scanner] OOR recheck priority — ${recentlyClosedOorMints.size - missed.length} token(s) queued` +
      `${missed.length ? `, ${missed.length} did not pass lane filters` : ''}`,
    )
  }

  console.log('[scanner] step 3/4 — live Meteora exposure + DB fallback check')

  const limitState = await withTimeout(
    getOpenLpLimitState('market'),
    METEORA_FETCH_TIMEOUT_MS,
    'live Meteora position limit state',
  )
  let openCount: number | undefined
  let availableOpenSlots = 0
  let openBlockedReason: string | undefined

  if (!limitState) {
    openBlockedReason = 'position_limit_unavailable'
    console.warn('[scanner] position limit check unavailable — scoring candidates but refusing to open new positions')
  } else {
    openCount = limitState.effectiveOpenCount
    if (!limitState.liveFetchOk) {
      console.warn(
        `[scanner] live position count incomplete (dlmmOk=${limitState.dlmmOk}, dammOk=${limitState.dammOk}) — ` +
        `using Supabase cache fallback for open caps`,
      )
    }
    availableOpenSlots = Math.max(0, MAX_CONCURRENT_MARKET_LP_POSITIONS - openCount)
    if (availableOpenSlots === 0) {
      openBlockedReason = 'max_positions_reached'
      console.log(
        `[scanner] max market LP positions reached (${openCount}/${MAX_CONCURRENT_MARKET_LP_POSITIONS}; ` +
        `source=${limitState.countSource}, live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount}) — scoring candidates only`,
      )
    }
  }

  console.log(
    `[scanner] step 4/4 — deep checks on ${survivors.length} lane survivors ` +
    `(fresh cap=${MAX_FRESH_DEEP_CHECKS}, momentum cap=${MAX_MOMENTUM_DEEP_CHECKS}, total queued from ${allSurvivors.length})`,
  )
  let candidateCount = 0
  let openedCount = 0
  let openedDammCountThisTick = 0
  let openSkippedCount = 0
  let dailyLossLimitHit: boolean | null = null
  const heliusRpcUrl = getHeliusRpcEndpoint() ?? ''
  const openedMintsThisTick = new Set<string>()
  const isOpenAllowedToday = async (): Promise<boolean> => {
    if (dailyLossLimitHit === null) {
      dailyLossLimitHit = await isDailyLossLimitHit()
    }
    if (dailyLossLimitHit) {
      console.warn('[scanner] daily loss limit hit — no new positions')
      return false
    }
    return true
  }

  for (const { pool: representativePool, mcUsd, ageHours, lane } of survivors) {
    await new Promise(r => setTimeout(r, DEEP_CHECK_DELAY_MS))

    const token = getTradableToken(representativePool)
    const tokenAddress = token.address
    const symbol = representativePool.name ?? token.symbol
    const launchpadSource = detectLaunchpadSource(tokenAddress)
    const liveOpenPosition = findLiveOpenPosition(limitState, tokenAddress, representativePool.address)

    if (openedMintsThisTick.has(tokenAddress)) {
      console.log(`[scanner] ${symbol} — skip ${lane} lane: position already opened earlier this tick`)
      continue
    }

    if (CANDIDATE_DEDUP_HOURS > 0) {
      const recentResult = await withTimeout(
        supabase.from('candidates').select('id').eq('token_address', tokenAddress)
          .gte('scanned_at', new Date(Date.now() - CANDIDATE_DEDUP_HOURS * 60 * 60 * 1000).toISOString()).limit(1),
        SUPABASE_TIMEOUT_MS, `candidates dedup ${symbol}`
      )
      if (recentResult?.data && recentResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: scanned in last ${CANDIDATE_DEDUP_HOURS}h`); continue }
    }

    if (liveOpenPosition) {
      console.log(`[scanner] ${symbol} — skip: live Meteora position already exists (${liveOpenPosition.position_pubkey})`)
      continue
    }

    if (!limitState?.liveFetchOk) {
      const posResult = await withTimeout(
        supabase.from('lp_positions').select('id').eq('mint', tokenAddress)
          .in('status', OPEN_LP_STATUSES).limit(1),
        SUPABASE_TIMEOUT_MS, `lp_positions fallback dedup ${symbol}`
      )
      if (posResult?.data && posResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: cached open LP position exists (live fallback mode)`); continue }
    }

    // Pump.fun high-curve detection: log progress, then fall through to normal scoring.
    // The scorer awards +8 curveBonus at 70-95% and +4 at 95-99%.
    if (isPumpFunToken(tokenAddress) && heliusRpcUrl && ageHours < 48) {
      const curve = await getCachedPumpFunBondingCurve(tokenAddress, heliusRpcUrl)
      const progress = curve?.progressPct ?? 0
      if (progress >= PUMPFUN_HIGHCURVE_THRESHOLD && curve?.complete === false) {
        console.log(`[scanner] ${symbol} — pump.fun high-curve ${progress.toFixed(1)}% — scoring normally (+curveBonus)`)
      } else {
        console.log(`[scanner] ${symbol} — pump.fun curve ${progress.toFixed(1)}% (complete=${curve?.complete ?? 'unknown'})`)
      }
      // Always fall through to normal pool selection and scoring
    }

    const bestPool = selectBestPool(lane === 'fresh' ? freshPools : momentumPools, tokenAddress, lane)
    if (!bestPool) {
      console.log(`[scanner] ${symbol} — skip: no qualifying pool found after best-pool selection`)
      continue
    }
    const liveBestPoolPosition = findLiveOpenPosition(limitState, tokenAddress, bestPool.address)
    if (liveBestPoolPosition) {
      console.log(`[scanner] ${symbol} — skip: live Meteora position already exists for best pool (${liveBestPoolPosition.position_pubkey})`)
      continue
    }

    const poolAgeHours  = getPoolAgeMinutes(bestPool) / 60
    const liqUsd        = getPoolTvl(bestPool)
    const feeTvl24hPct  = getFeeTvlPct(bestPool, '24h')
    const feeTvl1hPct   = getFeeTvlPct(bestPool, '1h')
    const feeTvl5mPct   = getFeeTvlPct(bestPool, '5m')
    const volumeTvl1hRatio = getVolumeTvlRatio(bestPool, '1h')
    const volumeGrowth1h = getRecentVolumeGrowth(bestPool)
    const momentumScore = scoreMeteoraMomentum(bestPool)

    // New Meteora listing fast-path: log and fall through to normal scoring.
    if (
      poolAgeHours < METEORA_NEW_LISTING_AGE_H &&
      liqUsd >= METEORA_NEW_LISTING_LIQ_USD &&
      Math.max(feeTvl1hPct, feeTvl5mPct * 12) >= METEORA_NEW_LISTING_FEETVL
    ) {
      console.log(
        `[scanner] ${symbol} — new Meteora listing ` +
        `(${(poolAgeHours * 60).toFixed(0)}min old, liq=$${liqUsd.toFixed(0)}, recentFeeTvl=${Math.max(feeTvl1hPct, feeTvl5mPct * 12).toFixed(1)}%) — scoring normally`
      )
      // fall through to normal scoring + openPosition
    }

    const quoteTokenMint = getQuoteTokenMint(bestPool)

    const vol24h  = getPoolVolume(bestPool, '24h')
    const vol1h   = getPoolVolume(bestPool, '1h')
    const vol5m   = getPoolVolume(bestPool, '5m')
    const binStep: number | undefined = bestPool.pool_config?.bin_step
    const binStepDisplay = binStep ?? '?'

    if (bestPool.address !== representativePool.address) {
      console.log(`[scanner] ${symbol} — best pool upgraded: bin_step=${binStepDisplay}, feeTvl=${feeTvl24hPct.toFixed(2)}%, tvl=$${liqUsd.toFixed(0)}`)
    }

    let resolvedMc = mcUsd
    if (!resolvedMc || resolvedMc < 1) {
      resolvedMc = await fetchMcFromDexScreener(tokenAddress, token.price)
      if (!resolvedMc || resolvedMc < 1) {
        if (lane !== 'fresh') {
          console.log(`[scanner] ${symbol} — skip: no market_cap`)
          continue
        }
        resolvedMc = 0
        console.log(`[scanner] ${symbol} — no market_cap yet; fresh lane will rely on liquidity + Rugcheck`)
      }
    }

    let holderCount  = 0
    let topHolderPct = 0

    if (USE_HELIUS) {
      console.log(`[scanner] ${symbol} — calling Helius`)
      const holderData = await checkHolders(tokenAddress)
      holderCount  = holderData.holderCount
      topHolderPct = holderData.topHolderPct
      if (!holderData.reliable && token.holders) {
        holderCount = Math.max(holderCount, token.holders)
      }
    } else {
      holderCount  = token.holders ?? 0
      topHolderPct = 0
      console.log(`[scanner] ${symbol} — using Meteora holders (Helius disabled)`)
    }

    console.log(`[scanner] ${symbol} — calling Rugcheck`)
    const rugScore = await getRugscore(tokenAddress, symbol)

    const holderCountForFilter = holderCount > 0 ? holderCount : (token.holders ?? 0)

    let bondingCurvePct: number | undefined = undefined
    if (isPumpFunToken(tokenAddress) && heliusRpcUrl && ageHours < 48) {
      const curve = await getCachedPumpFunBondingCurve(tokenAddress, heliusRpcUrl)
      bondingCurvePct = curve?.progressPct ?? undefined
      if (bondingCurvePct !== undefined) {
        console.log(`[pumpfun] ${symbol} bonding curve: ${bondingCurvePct.toFixed(1)}% (complete=${curve?.complete ?? 'unknown'})`)
      }
    }

    const metrics: TokenMetrics = {
      address:        tokenAddress,
      symbol,
      mcUsd:          resolvedMc,
      volume24h:      vol24h,
      liquidityUsd:   liqUsd,
      topHolderPct,
      holderCount:    holderCountForFilter,
      ageHours,
      rugcheckScore:  rugScore,
      priceUsd:       token.price,
      poolAddress:    bestPool.address,
      dexId:          'meteora',
      feeTvl24hPct,
      feeTvl1hPct,
      feeTvl5mPct,
      volume1h:       vol1h,
      volume5m:       vol5m,
      volumeTvl1hRatio,
      volumeGrowth1h,
      momentumScore,
      bondingCurvePct,
      quoteTokenMint,
      binStep,
    }

    // ========== DAMM v2 EDGE (additive hook — Meteora-origin pools only) =======
    // Fires ONLY for native Meteora pools (launchpadSource === 'meteora').
    // If the token qualifies, resolves a verified DAMM v2 pool before opening.
    // The DLMM path is skipped only after a DAMM open actually succeeds.
    // All existing DLMM strategy logic below is
    // untouched — this block is pure additive code.
    if (lane === 'fresh' && launchpadSource === 'meteora' && process.env.DAMM_EDGE_ENABLED === 'true') {
      const dammDecision = await evaluateDammEdge(tokenAddress, metrics)
      console.log(`[scanner][damm-edge] ${symbol}: ${dammDecision.reason}`)
      if (dammDecision.shouldUseDamm && dammDecision.params) {
        if (openBlockedReason || openedCount >= availableOpenSlots) {
          const reason = openBlockedReason ?? 'slots_filled_this_tick'
          console.log(`[scanner][damm-edge] ${symbol} qualifies but DAMM open skipped: ${reason}; continuing DLMM evaluation`)
        } else if (!await isOpenAllowedToday()) {
          openSkippedCount++
          console.log(`[scanner][damm-edge] ${symbol} qualifies but DAMM open skipped: daily loss circuit breaker`)
        } else {
          const openDammCount = getOpenDammEdgeCount(limitState) + openedDammCountThisTick
          if (openDammCount >= MAX_CONCURRENT_DAMM_POSITIONS) {
            console.log(
              `[scanner][damm-edge] max DAMM positions reached ` +
              `(${openDammCount}/${MAX_CONCURRENT_DAMM_POSITIONS}) — continuing DLMM evaluation`,
            )
          } else {
            const verifiedDammPool = await resolveVerifiedDammV2PoolForToken({
              tokenAddress,
              quoteMint: WSOL,
            })

            if (!verifiedDammPool) {
              console.log(`[scanner][damm-edge] ${symbol} has no verified DAMM v2 SOL pool; continuing DLMM evaluation`)
            } else {
              const dammParams = {
                ...dammDecision.params,
                poolAddress: verifiedDammPool.poolAddress,
                metadata: {
                  ...(dammDecision.params.metadata ?? {}),
                  damm_pool_resolver_source: verifiedDammPool.source,
                  scanner_source_pool_address: metrics.poolAddress,
                  verified_damm_pool_address: verifiedDammPool.poolAddress,
                  verified_damm_token_a_mint: verifiedDammPool.tokenAMint,
                  verified_damm_token_b_mint: verifiedDammPool.tokenBMint,
                },
              }

              console.log(
                `[scanner][damm-edge] TRIGGERED — opening verified DAMM v2 position for ${symbol} ` +
                `pool=${verifiedDammPool.poolAddress} source=${verifiedDammPool.source}`,
              )
              const result = await openDammPosition(dammParams)
              if (result.success) {
                openedCount++
                openedDammCountThisTick++
                dailyLossLimitHit = null
                openedMintsThisTick.add(tokenAddress)
                await sendAlert({
                  type:          'position_opened',
                  symbol,
                  strategy:      'damm-edge',
                  solDeposited:  dammParams.solAmount,
                  entryPrice:    metrics.priceUsd,
                  positionId:    result.positionId ?? result.positionPubkey,
                  poolAddress:   verifiedDammPool.poolAddress,
                  mint:          tokenAddress,
                })

                continue
              }

              console.error(`[scanner][damm-edge] openDammPosition failed for ${symbol}: ${result.error}; continuing DLMM evaluation`)
            }
          }
        }
      }
    } else if (lane === 'fresh' && launchpadSource === 'meteora' && process.env.DAMM_EDGE_ENABLED !== 'true') {
      console.log(`[scanner][damm-edge] ${symbol} DAMM edge path disabled (DAMM_EDGE_ENABLED !== true); continuing DLMM evaluation`)
    }
    // ========== END DAMM v2 EDGE ================================================

    const tokenClass = lane === 'momentum' ? 'SCALP_SPIKE' : classifyToken({
      address:        metrics.address,
      mcUsd:          metrics.mcUsd,
      volume24h:      metrics.volume24h,
      volume1h:       vol1h,
      volume5m:       vol5m,
      liquidityUsd:   metrics.liquidityUsd,
      ageHours:       metrics.ageHours,
      topHolderPct:   metrics.topHolderPct,
      holderCount:    metrics.holderCount,
      rugcheckScore:  metrics.rugcheckScore,
      quoteTokenMint: metrics.quoteTokenMint,
      feeTvl1hPct:    metrics.feeTvl1hPct,
      feeTvl5mPct:    metrics.feeTvl5mPct,
      feeTvl24hPct:   metrics.feeTvl24hPct,
    })

    const forcedStrategyId = lane === 'momentum' ? 'scalp-spike' : 'evil-panda'
    const momentumRegain = lane === 'momentum' && passesMomentumRegain(bestPool)
    const strategy =
      getStrategyForToken({ ...metrics, volume1h: vol1h, volume5m: vol5m }, forcedStrategyId) ??
      (momentumRegain && passesMomentumRegainStrategyFilters(metrics) ? scalpSpikeStrategy : null)
    if (!strategy) {
      const rejectionReason = explainNoStrategy(metrics)
      console.log(`[scanner] ${symbol} — no strategy in ${lane} lane (class=${tokenClass}, quote=${quoteTokenMint}): ${rejectionReason}`)
      console.log(JSON.stringify({
        event:     'candidate_evaluated',
        mint:      tokenAddress,
        symbol,
        score:     0,
        lane,
        launchpad: launchpadSource,
        decision:  'REJECTED',
        reason:    rejectionReason,
      }))
      continue
    }

    if (strategy.id === 'scalp-spike' && momentumRegain) {
      console.log(
        `[scanner] ${symbol} — scalp-spike momentum-regain ` +
        `vol1h/24hAvg=${getOneHourVolumeVs24hAverage(bestPool).toFixed(2)}x ` +
        `fee1h/24hAvg=${getOneHourFeeTvlVs24hAverage(bestPool).toFixed(2)}x`,
      )
    }

    const breakdown = strategy.id === 'scalp-spike' && momentumRegain
      ? getMomentumRegainBreakdown(metrics)
      : scoreCandidateWithBreakdown(metrics, strategy)
    const score       = getScannerAdjustedScore(metrics, strategy.id, breakdown)
    const bondingInfo = bondingCurvePct !== undefined ? `, curve=${bondingCurvePct.toFixed(1)}%` : ''

    const accepted = lane === 'fresh' ? score > 0 : score >= MIN_SCORE_TO_OPEN
    const rejectionReason = !accepted
      ? lane === 'fresh'
        ? 'fresh safety check failed'
        : `score ${score} < threshold ${MIN_SCORE_TO_OPEN}`
      : null

    console.log(JSON.stringify({
      event:     'candidate_evaluated',
      mint:      tokenAddress,
      symbol,
      score,
      breakdown: {
        score_volmc:       breakdown.volMcScore,
        score_holders:     breakdown.holderScore,
        score_freshness:   breakdown.freshnessScore,
        score_fee_efficiency: breakdown.feeEfficiencyScore,
        score_volume_tvl:  breakdown.volumeTvlScore,
        score_curve_bonus: breakdown.curveBonus,
        final_score:       score,
      },
      launchpad: launchpadSource,
      lane,
      decision:  accepted ? 'ACCEPTED' : 'REJECTED',
      reason:    rejectionReason,
    }))

    const insertResult = await withTimeout(
      supabase.from('candidates').insert({
        token_address:     metrics.address,
        symbol:            metrics.symbol,
        score,
        strategy_matched:  strategy.id,
        strategy_id:       strategy.id,
        token_class:       tokenClass,
        scanner_lane:      lane,
        pool_address:      metrics.poolAddress,
        mc_at_scan:        metrics.mcUsd,
        volume_24h:        metrics.volume24h,
        volume_1h:         vol1h,
        volume_5m:         vol5m,
        liquidity_usd:     metrics.liquidityUsd,
        fee_tvl_24h_pct:   feeTvl24hPct,
        fee_tvl_1h_pct:    feeTvl1hPct,
        fee_tvl_5m_pct:    feeTvl5mPct,
        holder_count:      metrics.holderCount,
        rugcheck_score:    metrics.rugcheckScore,
        top_holder_pct:    metrics.topHolderPct,
        bin_step:          binStep,
        scanned_at:        new Date().toISOString(),
        score_volmc:       breakdown.volMcScore,
        score_holders:     breakdown.holderScore,
        score_freshness:   breakdown.freshnessScore,
        score_fee_efficiency: breakdown.feeEfficiencyScore,
        score_volume_tvl:  breakdown.volumeTvlScore,
        score_curve_bonus: breakdown.curveBonus,
        launchpad_source:  launchpadSource,
      }),
      SUPABASE_TIMEOUT_MS, `candidates insert ${symbol}`
    )

    const insertOk = insertResult !== null && !('error' in insertResult && insertResult.error)
    if (!insertOk) {
      const errMsg = insertResult && 'error' in insertResult ? insertResult.error?.message : 'timeout'
      console.error(`[scanner] candidates insert failed for ${symbol} — skipping openPosition:`, errMsg)
      continue
    }

    candidateCount++
    console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (${lane} lane, class=${tokenClass}, quote=${quoteTokenMint}, score=${score}, mc=$${resolvedMc.toFixed(0)}, vol=$${vol24h.toFixed(0)}, vol1h=$${vol1h.toFixed(0)}, vol5m=$${vol5m.toFixed(0)}, feeTvl24h=${feeTvl24hPct.toFixed(2)}%, feeTvl1h=${feeTvl1hPct.toFixed(2)}%, feeTvl5m=${feeTvl5mPct.toFixed(2)}%, volTvl1h=${volumeTvl1hRatio.toFixed(2)}, momentum=${momentumScore}, holders=${holderCountForFilter}, rug=${rugScore}, age=${ageHours.toFixed(1)}h, binStep=${binStepDisplay}${bondingInfo})`)
    await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct })

    if (accepted) {
      const disabledReason = getDisabledStrategyReason(strategy.id)
      if (disabledReason) {
        openSkippedCount++
        console.log(`[scanner] ${symbol} qualifies for ${strategy.id} but open skipped: ${disabledReason}`)
        continue
      }

      if (openBlockedReason || openedCount >= availableOpenSlots) {
        openSkippedCount++
        const reason = openBlockedReason ?? 'slots_filled_this_tick'
        console.log(`[scanner] ${symbol} qualifies but open skipped: ${reason}`)
        continue
      }

      if (!await isOpenAllowedToday()) {
        openSkippedCount++
        console.log(`[scanner] ${symbol} qualifies but open skipped: daily loss circuit breaker`)
        continue
      }

      const positionId = await openPosition(metrics, strategy)
      if (positionId) {
        openedCount++
        dailyLossLimitHit = null
        openedMintsThisTick.add(tokenAddress)
        await sendAlert({
          type: 'position_opened',
          symbol,
          strategy: strategy.id,
          solDeposited: MARKET_LP_SOL_PER_POSITION,
          entryPrice: metrics.priceUsd,
          entryPriceUsd: metrics.priceUsd,
          meteoracleScore: score,
          poolAddress: metrics.poolAddress,
          mint: metrics.address,
          positionId,
        })
      }
    }
  }

  if (USE_HELIUS) {
    const { getHolderCacheSize } = await import('@/lib/helius')
    console.log(`[scanner] Helius cache: ${getHolderCacheSize()} entries`)
  }
  console.log(`[scanner] Rugcheck cache: ${getRugcheckCacheSize()} entries`)

  console.log(
    `[scanner] done — scanned: ${pools.length}, survivors: ${allSurvivors.length}, ` +
    `deep-checked: ${survivors.length}, candidates: ${candidateCount}, opened: ${openedCount}, ` +
    `open-skipped: ${openSkippedCount}${openBlockedReason ? ` (${openBlockedReason})` : ''}`,
  )
  return finish({
    scanned: pools.length,
    survivors: allSurvivors.length,
    deepChecked: survivors.length,
    candidates: candidateCount,
    opened: openedCount,
    openSkipped: openSkippedCount,
    openSlots: availableOpenSlots,
    openCount,
    openBlockedReason,
  })
}

async function fetchMcFromDexScreener(mint: string, fallbackPrice: number): Promise<number> {
  try {
    const res = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 6_000 })
    const pairs: Array<{ fdv?: number; marketCap?: number }> = res.data?.pairs ?? []
    if (pairs.length === 0) return 0
    return pairs[0].marketCap ?? pairs[0].fdv ?? 0
  } catch {
    return 0
  }
}

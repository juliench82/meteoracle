import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import axios from 'axios'
// Supabase fully removed in simplified stack - using local-state + local-logger only
import { getBotState } from '@/lib/botState'
import { getStrategyForToken, classifyToken, explainNoStrategy } from '@/strategies'
import { scoreCandidateWithBreakdown, type ScoreBreakdown } from '../scorer'
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
// (DAMM v2 edge automation fully removed)
import { EVIL_PANDA_SCANNER_SCORE_WEIGHTS } from '@/strategies/evil-panda'
import { scalpSpikeStrategy } from '@/strategies/scalp-spike' // stub for simplified stack compatibility
import { openMoonboyPosition } from '../moonboy-executor'
import { moonboyStrategy } from '@/strategies/moonboy'
import { OPEN_LP_STATUSES, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { getHeliusRpcEndpoint } from '@/lib/solana'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import { isDailyLossLimitHit } from '@/lib/circuit-breaker'
import { logInfo, logError } from '@/lib/log'
import { getOpenLpPositions, saveOpenLpPositions } from '@/lib/local-state'
import {
  SCAN_INTERVAL_MS,
  SCANNER_TICK_TIMEOUT_MS,
  CANDIDATE_DEDUP_HOURS,
  OOR_RECHECK_HOURS,
  HARD_MAX_TOKEN_AGE_MINUTES,
  SCANNER_EARLY_MAX_AGE_MINUTES,
  FRESH_SNIPE_MAX_AGE_MINUTES,
  FRESH_MAX_AGE_MINUTES,
  FRESH_MIN_LIQUIDITY_USD,
  MOMENTUM_MIN_VOLUME_5M_USD,
  MOMENTUM_MIN_FEE_TVL_5M_PCT,
  SCALP_SPIKE_VOL_RATIO,
  MAX_DEEP_CHECKS,
  DEEP_CHECK_DELAY_MS,
  MAX_FRESH_DEEP_CHECKS,
  MAX_MOMENTUM_DEEP_CHECKS,
  MIN_SCORE_TO_OPEN,
  MATURE_MIN_SCORE_TO_OPEN,
  MOMENTUM_POOL_LIMIT,
  LP_SCANNER_ENABLED,
  EVIL_PANDA_ENABLED,
  SCALP_SPIKE_ENABLED,
} from '@/lib/strategy-config'
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
  cleanupOldPoolCache,
} from './pool-fetcher'
import {
  classifyPoolsIntoLanes,
  pickDeepCheckSurvivors,
  survivorTokenAddress,
  selectBestPool,
  passesMomentumRegain,
  getOneHourVolumeVs24hAverage,
  getOneHourFeeTvlVs24hAverage,
} from './lane-classifier'

const DEXSCREENER     = 'https://api.dexscreener.com/latest/dex/tokens'

const JUP_PRICE_URL = 'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112'

const PRE_FILTER = {
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 500_000_000,
}

export const MAX_CONCURRENT_MARKET_LP_POSITIONS = parseInt(
  process.env.MAX_CONCURRENT_MARKET_LP_POSITIONS ?? process.env.MAX_CONCURRENT_POSITIONS ?? '5',
)
const MARKET_LP_SOL_PER_POSITION = parseFloat(
  process.env.MAX_MARKET_LP_SOL_PER_POSITION ??
  process.env.MARKET_LP_SOL_PER_POSITION ??
  process.env.MAX_SOL_PER_POSITION ??
  '0.1',
)


const METEORA_FILTERED_FETCH = {
  minTvlUsd: parseFloat(process.env.METEORA_MIN_TVL_USD ?? '8000'),
  minFeeTvlRatio1h: parseFloat(process.env.METEORA_MIN_FEE_TVL_RATIO_1H ?? '0.001'),
  minVolumeTvl1hRatio: parseFloat(process.env.METEORA_MIN_VOLUME_TVL_1H_RATIO ?? '0.20'),
  limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '800'),
}

// (DAMM-related new listing constants removed)

const SUPABASE_TIMEOUT_MS      = 10_000
const METEORA_FETCH_TIMEOUT_MS = 45_000
const EXTERNAL_CALL_TIMEOUT_MS = 8_000
const USE_HELIUS               = process.env.HELIUS_ENABLED === 'true'

// Re-export central scanner timing so bot/scanner.ts keeps working without changes
export { SCAN_INTERVAL_MS } from '@/lib/strategy-config'

const _bondingCurveCache = new Map<string, { pct: number; complete: boolean | null; ts: number }>()
const BONDING_CACHE_TTL_MS = 10 * 60 * 1_000

type CachedBondingCurve = {
  progressPct: number
  complete: boolean | null
}

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
  tickMode?: boolean
}

function detectLaunchpadSource(tokenAddress: string): 'pumpfun' | 'moonshot' | 'meteora' {
  if (isPumpFunToken(tokenAddress)) return 'pumpfun'
  if (isMoonshotToken(tokenAddress)) return 'moonshot'
  return 'meteora'
}

export async function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T | null> {
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
  // Simplified stack: use the proper local logger
  logInfo(result.error ? 'scanner_tick_failed' : 'scanner_tick', { ...result, durationMs, source })
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
    // Simplified stack: just log locally
    logInfo('scanner_heartbeat', payload)
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

  const curve = await withTimeout(
    fetchBondingCurve(tokenAddress, heliusRpcUrl),
    EXTERNAL_CALL_TIMEOUT_MS,
    `fetchBondingCurve ${tokenAddress.slice(0, 8)}`,
  )
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
  return (limitState?.livePositions || []).find((position: any) =>
    position.mint === tokenAddress ||
    (!!poolAddress && position.pool_address === poolAddress),
  ) ?? null
}

function getDisabledStrategyReason(strategyId: string): string | null {
  if (strategyId === 'scalp-spike' && !SCALP_SPIKE_ENABLED) return 'SCALP_SPIKE_ENABLED is not true'
  if (strategyId === 'evil-panda' && !EVIL_PANDA_ENABLED) return 'EVIL_PANDA_ENABLED is not true'
  return null
}

// getOpenDammEdgeCount removed (DAMM Edge scoring deleted)

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

function scoreHolderCount(holderCount: number, reliable: boolean = true): number {
  if (!reliable) {
    return 0 // Do not contribute holder score if data is unreliable (Helius DAS fallback / capped)
  }

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
  const holderScore = scoreHolderCount(metrics.holderCount, metrics.holderReliable ?? true)
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

// Simplified stack: OOR recheck via Supabase removed for now.
// Returns empty set (feature disabled until re-implemented on local state if desired).
async function fetchRecentlyClosedOorMints(): Promise<Set<string>> {
  if (OOR_RECHECK_HOURS <= 0) return new Set()
  return new Set()
}

/**
 * Attempt a Moonboy companion spot-buy ($10) right after a successful LP open.
 * This is the single authoritative trigger point for Moonboy.
 *
 * Fire-and-forget. Uses the tick's live SOL price and the Moonboy strategy's age gate (1.5h).
 */
async function maybeTriggerMoonboy(metrics: TokenMetrics, solPriceUsd: number): Promise<void> {
  const isDryRun = process.env.BOT_DRY_RUN === 'true'
  const label = `[moonboy][${metrics.symbol}]`

  if (!moonboyStrategy.enabled) {
    if (isDryRun) {
      console.log(`${label} would have fired companion buy (strategy disabled)`)
    }
    return
  }

  const maxAge = moonboyStrategy.filters.maxAgeHours
  if (metrics.ageHours > maxAge) {
    if (isDryRun) {
      console.log(`${label} would have fired but age ${metrics.ageHours.toFixed(1)}h > ${maxAge}h gate`)
    } else {
      console.log(`${label} skipped — age ${metrics.ageHours.toFixed(1)}h > ${maxAge}h gate`)
    }
    return
  }

  console.log(`${label} triggering companion spot-buy after LP open (age=${metrics.ageHours.toFixed(1)}h)`)

  try {
    const moonboyId = await openMoonboyPosition(metrics, solPriceUsd)
    if (moonboyId) {
      console.log(`${label} companion spot-buy succeeded (id=${moonboyId})`)
    } else {
      console.log(`${label} companion spot-buy did not open (see moonboy logs above)`)
    }
  } catch (err) {
    console.warn(
      `${label} openMoonboyPosition threw (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Resolve SOL price in USD — now uses live Jupiter (same source as monitor) with env fallback. */
async function resolveSolPriceUsd(): Promise<number> {
  try {
    const res = await fetch(JUP_PRICE_URL, { signal: AbortSignal.timeout(4_000) })
    if (res.ok) {
      const json = await res.json() as { data?: Record<string, { price?: string | number }> }
      const rawPrice = json.data?.['So11111111111111111111111111111111111111112']?.price
      const price = typeof rawPrice === 'string' ? parseFloat(rawPrice) : rawPrice
      if (typeof price === 'number' && price > 0) return price
    }
  } catch {}
  const envSolPrice = parseFloat(process.env.SOL_PRICE_USD ?? '')
  return Number.isFinite(envSolPrice) && envSolPrice > 0 ? envSolPrice : 150
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

export interface RunScannerOptions {
  tickMode?: boolean
}

export async function runScanner(opts: RunScannerOptions = {}): Promise<ScannerResult> {
  if (scannerRunPromise) {
    const ageMs = Date.now() - scannerRunStartedAt
    console.warn(`[scanner] previous tick still running (${Math.round(ageMs / 1000)}s) — skipping overlapping tick`)
    return emptyScannerResult({
      openBlockedReason: ageMs > SCANNER_TICK_TIMEOUT_MS ? 'scanner_tick_watchdog_active' : 'scanner_tick_in_flight',
    })
  }

  scannerRunStartedAt = Date.now()
  const run = runScannerOnce(opts).finally(() => {
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

async function runScannerOnce(opts: RunScannerOptions = {}): Promise<ScannerResult> {
  const { tickMode = false } = opts
  const startedAt = Date.now()
  const finish = async (result: Partial<ScannerResult>): Promise<ScannerResult> => {
    const fullResult = emptyScannerResult({ ...result, tickMode })
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

  if (tickMode) {
    console.log('[scanner] tickMode=true — skipping pool-fetcher (simplified stack: no candidates table)')
    return finish({
      scanned: 0,
      survivors: 0,
      deepChecked: 0,
      candidates: 0,
      opened: 0,
      openSkipped: 0,
      openBlockedReason: 'tick_mode_no_open',
    })
  }

  console.log('[scanner] step 1/4 — fetching Meteora pools')
  const laneConfig = {
    freshMaxAgeMinutes: FRESH_MAX_AGE_MINUTES,
    freshMinLiquidityUsd: FRESH_MIN_LIQUIDITY_USD,
    momentumMinVolume5mUsd: MOMENTUM_MIN_VOLUME_5M_USD,
    momentumMinFeeTvl5mPct: MOMENTUM_MIN_FEE_TVL_5M_PCT,
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

  const { freshPools, momentumPools, freshSurvivors, momentumSurvivors } =
    classifyPoolsIntoLanes(fetchedPools, laneConfig)

  console.log(
    `[scanner] lanes — fresh=${freshPools.length}, momentum=${momentumPools.length} (from ${fetchedPools.length} pools)`
  )

  const recentlyClosedOorMints = await fetchRecentlyClosedOorMints()
  const survivors = pickDeepCheckSurvivors(freshSurvivors, momentumSurvivors, recentlyClosedOorMints, laneConfig)

  if (survivors.length === 0) {
    console.log('[scanner] done — no survivors after lane filters')
    return finish({ scanned: fetchedPools.length, survivors: 0 })
  }

  console.log(`[scanner] deep checks on ${survivors.length} survivors`)

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
        `[scanner] live position count incomplete (dlmmOk=${limitState.dlmmOk}) — ` +
        `using Supabase cache fallback for open caps (DAMM v2 support removed)`,
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

  console.log(`[scanner] step 4/4 — deep checks on ${survivors.length} survivors`)
  let candidateCount = 0
  let openedCount = 0
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

  // Pre-fetch live SOL price once per tick for accurate MC and position sizing
  const liveSolPriceUsd = await resolveSolPriceUsd()

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
      // candidates dedup via Supabase removed in simplified stack.
      // For now we skip the DB dedup (or implement simple local dedup later).
      // To keep the simplified behavior, we just continue without the check for now.
    }

    if (liveOpenPosition) {
      console.log(`[scanner] ${symbol} — skip: live Meteora position already exists (${liveOpenPosition.position_pubkey})`)
      continue
    }

    // Strong per-mint dedup for LP positions.
    // 1. Skip if there is currently an open/active position for this mint.
    // 2. Skip if there was a recent position for this mint (last 6 hours) that was closed with a "bad" reason
    //    (e.g. pnl_unavailable). This prevents rapid re-opening the same mint after a failed/bad close attempt.
    // Strong per-mint dedup using local state only (simplified stack)
    const recentClosedCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const allPositions = getOpenLpPositions();

    const conflicting = allPositions.find((p: any) => {
      if (p.mint !== tokenAddress) return false;
      if (OPEN_LP_STATUSES.includes(p.status)) return true;
      if (p.status === 'closed' && p.closed_at && p.closed_at >= recentClosedCutoff) {
        const reason = p.close_reason || '';
        if (reason.startsWith('pnl_unavailable') || reason.startsWith('bad')) return true;
      }
      return false;
    });

    if (conflicting) {
      if (OPEN_LP_STATUSES.includes(conflicting.status)) {
        console.log(`[scanner] ${symbol} — skip: existing open LP position for mint (id=${conflicting.id})`);
      } else {
        console.log(`[scanner] ${symbol} — skip: recent bad close for this mint (id=${conflicting.id}, reason=${conflicting.close_reason})`);
      }
      continue;
    }

    if (isPumpFunToken(tokenAddress) && heliusRpcUrl && ageHours < 48) {
      const curve = await getCachedPumpFunBondingCurve(tokenAddress, heliusRpcUrl)
      const progress = curve?.progressPct ?? 0
      if (progress >= PUMPFUN_HIGHCURVE_THRESHOLD && curve?.complete === false) {
        console.log(`[scanner] ${symbol} — pump.fun high-curve ${progress.toFixed(1)}% — scoring normally (+curveBonus)`)
      } else {
        console.log(`[scanner] ${symbol} — pump.fun curve ${progress.toFixed(1)}% (complete=${curve?.complete ?? 'unknown'})`)
      }
    }

    // Simplified pool selection (aggressive simplification pass)
    const result = selectBestPool(
      lane === 'fresh' ? freshPools : momentumPools,
      tokenAddress
    )
    const bestPool = result.pool

    if (!bestPool) {
      console.log(`[scanner] ${symbol} — skip: no pool found for token`)
      continue
    }
    const liveBestPoolPosition = findLiveOpenPosition(limitState, tokenAddress, bestPool.address)
    if (liveBestPoolPosition) {
      console.log(`[scanner] ${symbol} — skip: live Meteora position already exists for best pool (${liveBestPoolPosition.position_pubkey})`)
      continue
    }

    const liqUsd        = getPoolTvl(bestPool)
    const feeTvl24hPct  = getFeeTvlPct(bestPool, '24h')
    const feeTvl1hPct   = getFeeTvlPct(bestPool, '1h')
    const feeTvl5mPct   = getFeeTvlPct(bestPool, '5m')
    const volumeTvl1hRatio = getVolumeTvlRatio(bestPool, '1h')
    const volumeGrowth1h = getRecentVolumeGrowth(bestPool)
    const momentumScore = scoreMeteoraMomentum(bestPool)

    // (DAMM v2 support fully removed)

    const quoteTokenMint = getQuoteTokenMint(bestPool)

    const vol24h  = getPoolVolume(bestPool, '24h')
    const vol1h   = getPoolVolume(bestPool, '1h')
    const vol5m   = getPoolVolume(bestPool, '5m')
    const binStepDisplay = bestPool.pool_config?.bin_step ?? '?'
    console.log(`[scanner] ${symbol} — selected pool (lane=${lane}, binStep=${binStepDisplay})`)

    // Improved MC: always try DexScreener for scalp-spike candidates or when Meteora MC is low/stale
    let resolvedMc = mcUsd
    const forcedStrategyId = lane === 'momentum' ? 'scalp-spike' : 'evil-panda'
    const isScalpSpikeCandidate = lane === 'momentum' || forcedStrategyId === 'scalp-spike'
    if (!resolvedMc || resolvedMc < 1 || (isScalpSpikeCandidate && resolvedMc < 500_000)) {
      resolvedMc = await withTimeout(
        fetchMcFromDexScreener(tokenAddress, token.price),
        EXTERNAL_CALL_TIMEOUT_MS,
        `fetchMcFromDexScreener ${symbol}`,
      ).then(v => v ?? 0)
    }
    if (!resolvedMc || resolvedMc < 1) {
      if (lane !== 'fresh') {
        console.log(`[scanner] ${symbol} — skip: no market_cap`)
        continue
      }
      resolvedMc = 0
      console.log(`[scanner] ${symbol} — no market_cap yet; fresh lane will rely on liquidity + Rugcheck`)
    }

    let holderCount  = 0
    let topHolderPct = 0
    let holderReliable = false

    if (USE_HELIUS) {
      console.log(`[scanner] ${symbol} — calling Helius`)
      const holderData = await withTimeout(
        checkHolders(tokenAddress),
        EXTERNAL_CALL_TIMEOUT_MS,
        `checkHolders ${symbol}`,
      )
      if (holderData) {
        holderCount  = holderData.holderCount
        topHolderPct = holderData.topHolderPct
        holderReliable = holderData.reliable
        if (!holderData.reliable) {
          console.log(`[scanner] ${symbol} — using unreliable holder data (holder score contribution disabled)`)
          if (token.holders) {
            holderCount = Math.max(holderCount, token.holders)
          }
        }
      } else {
        holderCount  = token.holders ?? 0
        topHolderPct = 0
        holderReliable = false
        console.warn(`[scanner] ${symbol} — Helius timeout, falling back to Meteora holders (${holderCount})`)
      }
    } else {
      holderCount  = token.holders ?? 0
      topHolderPct = 0
      holderReliable = false
      console.log(`[scanner] ${symbol} — using Meteora holders (Helius disabled)`)
    }



    console.log(`[scanner] ${symbol} — calling Rugcheck`)
    const rugScore = await withTimeout(
      getRugscore(tokenAddress, symbol),
      EXTERNAL_CALL_TIMEOUT_MS,
      `getRugscore ${symbol}`,
    ).then(v => v ?? 0)

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
      holderReliable,
      ageHours,
      rugcheckScore:  rugScore,
      priceUsd:       token.price,
      poolAddress:    bestPool.address,
      dexId:          'meteora',
      feeTvl24hPct,
      feeTvl1hPct,
      feeTvl5mPct:    feeTvl5mPct,
      volume1h:       vol1h,
      volume5m:       vol5m,
      volumeTvl1hRatio,
      volumeGrowth1h,
      momentumScore,
      bondingCurvePct,
      quoteTokenMint,
      binStep,
      launchpadSource,
    }

    // (DAMM v2 edge path was fully removed from the bot)

    const momentumRegain = lane === 'momentum' && passesMomentumRegain(bestPool)
    const strategy =
      getStrategyForToken({ ...metrics, volume1h: vol1h, volume5m: vol5m }, forcedStrategyId) ??
      (momentumRegain && passesMomentumRegainStrategyFilters(metrics) ? scalpSpikeStrategy : null)

    let decision = 'REJECTED'
    let rejectionReason: string | null = null
    let finalScore = 0
    let strategyMatched: string | null = null
    let breakdown: ScoreBreakdown = {
      total: 0,
      volMcScore: 0,
      rugScore: 0,
      holderScore: 0,
      freshnessScore: 0,
      feeEfficiencyScore: 0,
      volumeTvlScore: 0,
      curveBonus: 0,
    }

    if (!strategy) {
      rejectionReason = explainNoStrategy(metrics)
      decision = 'REJECTED'
      console.log(`[scanner][decision] ${symbol} — REJECTED (no strategy) in ${lane} lane: ${rejectionReason}`)
    } else {
      breakdown = scoreCandidateWithBreakdown(metrics, strategy)
      finalScore = getScannerAdjustedScore(metrics, strategy.id, breakdown)

      // Simplified single threshold (aggressive simplification)
      const meetsOpen = finalScore >= MIN_SCORE_TO_OPEN

      if (!meetsOpen) {
        rejectionReason = `score ${finalScore} < ${MIN_SCORE_TO_OPEN}`
        decision = 'REJECTED'
      } else {
        decision = 'ACCEPTED'
      }

      console.log(`[scanner][decision] ${symbol} — ${decision} (lane=${lane}, strategy=${strategy?.id ?? 'none'}, score=${finalScore})`)
    }

    if (decision === 'ACCEPTED' && strategy) {
      candidateCount++
      console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (lane=${lane}, score=${finalScore})`)

      await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score: finalScore, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct })

      // Open guards (simplified)
      const disabledReason = getDisabledStrategyReason(strategy.id)
      if (disabledReason) {
        openSkippedCount++
        console.log(`[scanner] ${symbol} open skipped: ${disabledReason}`)
        continue
      }
      if (openBlockedReason || openedCount >= availableOpenSlots) {
        openSkippedCount++
        console.log(`[scanner] ${symbol} open skipped: ${openBlockedReason ?? 'no_slots'}`)
        continue
      }
      if (!await isOpenAllowedToday()) {
        openSkippedCount++
        console.log(`[scanner] ${symbol} open skipped: daily loss circuit breaker`)
        continue
      }

      // Fire Moonboy companion (core simplified behavior)
      void maybeTriggerMoonboy(metrics, liveSolPriceUsd)

      const positionId = await openPosition(metrics, strategy)
      if (positionId) {
        openedCount++
        dailyLossLimitHit = null
        openedMintsThisTick.add(tokenAddress)

        console.log(`[scanner] ${symbol} — LP position opened ✔ (id=${positionId})`)

        // Claim strategy/symbol in local state (simplified)
        try {
          const positions = getOpenLpPositions();
          const idx = positions.findIndex((p: any) => p.id === positionId);
          if (idx !== -1) {
            positions[idx].strategy_id = strategy.id;
            positions[idx].symbol = symbol;
            saveOpenLpPositions(positions);
          }
        } catch {}


        await sendAlert({
          type: 'position_opened',
          symbol,
          strategy: strategy.id,
          solDeposited: MARKET_LP_SOL_PER_POSITION,
          entryPrice: metrics.priceUsd,
          entryPriceUsd: metrics.priceUsd,
          meteoracleScore: finalScore,
          poolAddress: metrics.poolAddress,
          mint: metrics.address,
          positionId,
        })
      } else {
        openSkippedCount++
        console.warn(
          `[scanner] ${symbol} — openPosition returned null (candidate was ACCEPTED but executor did not open). ` +
          `Check recent [executor][${strategy.id}][${symbol}] logs and bot_logs table for 'open_position_failed' or 'open_position_skipped_*' events.`
        )
      }
    }
  }

  if (USE_HELIUS) {
    const { getHolderCacheSize } = await import('@/lib/helius')
    console.log(`[scanner] Helius cache: ${getHolderCacheSize()} entries`)
  }
  console.log(`[scanner] Rugcheck cache: ${getRugcheckCacheSize()} entries`)

  // Periodically clean the scanner_pool_cache table. This is important because the persist path
  // (when enabled) writes a lot of data. Even when disabled, old data from previous runs can accumulate.
  void cleanupOldPoolCache()

  console.log(
    `[scanner] done — scanned=${fetchedPools.length}, survivors=${survivors.length}, ` +
    `candidates=${candidateCount}, opened=${openedCount}, skipped=${openSkippedCount}`
  )
  return finish({
    scanned: fetchedPools.length,
    survivors: survivors.length,
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

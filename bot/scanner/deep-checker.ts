import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import axios from 'axios'
// Local state + local logger only (Supabase removed from hot paths)
import { getBotState } from '@/lib/botState'
import { getStrategyForToken, explainNoStrategy } from '@/strategies'
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
import { EVIL_PANDA_SCANNER_SCORE_WEIGHTS } from '@/strategies/evil-panda'
import { openMoonboyPosition } from '../moonboy-executor'
import { moonboyStrategy } from '@/strategies/moonboy'
import { OPEN_LP_STATUSES, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { getHeliusRpcEndpoint } from '@/lib/solana'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import { isDailyLossLimitHit } from '@/lib/circuit-breaker'
import { logInfo } from '@/lib/log'
import { getOpenLpPositions, saveOpenLpPositions } from '@/lib/local-state'
import {
  SCAN_INTERVAL_MS,
  SCANNER_TICK_TIMEOUT_MS,
  CANDIDATE_DEDUP_HOURS,
  OOR_RECHECK_HOURS,
  FRESH_MAX_AGE_MINUTES,
  FRESH_MIN_LIQUIDITY_USD,
  MOMENTUM_MIN_VOLUME_5M_USD,
  MOMENTUM_MIN_FEE_TVL_5M_PCT,
  DEEP_CHECK_DELAY_MS,
  MAX_FRESH_DEEP_CHECKS,
  MAX_MOMENTUM_DEEP_CHECKS,
  MIN_SCORE_TO_OPEN,
  LP_SCANNER_ENABLED,
  EVIL_PANDA_ENABLED,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MARKET_LP_SOL_PER_POSITION,
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
} from './pool-fetcher'
import {
  classifyPoolsIntoLanes,
  pickDeepCheckSurvivors,
  selectBestPool,
  passesMomentumRegain,
} from './lane-classifier'

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens'
const JUP_PRICE_URL = 'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112'


const METEORA_FILTERED_FETCH = {
  minTvlUsd: parseFloat(process.env.METEORA_MIN_TVL_USD ?? '8000'),
  minFeeTvlRatio1h: parseFloat(process.env.METEORA_MIN_FEE_TVL_RATIO_1H ?? '0.001'),
  minVolumeTvl1hRatio: parseFloat(process.env.METEORA_MIN_VOLUME_TVL_1H_RATIO ?? '0.20'),
  limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '800'),
}

const METEORA_FETCH_TIMEOUT_MS = 45_000
const EXTERNAL_CALL_TIMEOUT_MS = 8_000
const USE_HELIUS               = process.env.HELIUS_ENABLED === 'true'

// Re-export values needed by bot/scanner.ts
export { SCAN_INTERVAL_MS, MAX_CONCURRENT_MARKET_LP_POSITIONS, MARKET_LP_SOL_PER_POSITION } from '@/lib/strategy-config'

const _bondingCurveCache = new Map<string, { pct: number; complete: boolean | null; ts: number }>()
const BONDING_CACHE_TTL_MS = 10 * 60 * 1_000

type CachedBondingCurve = {
  progressPct: number
  complete: boolean | null
}

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
  logInfo(result.error ? 'scanner_tick_failed' : 'scanner_tick', { ...result, durationMs, source })
}

export async function writeScannerHeartbeat(source: 'interval' | 'startup' = 'interval'): Promise<void> {
  try {
    const nowIso = new Date().toISOString()
    logInfo('scanner_heartbeat', {
      service: 'scanner',
      last_scan_at: nowIso,
      metadata: { source },
    })
  } catch (err) {
    console.warn('[scanner] heartbeat log failed:', err)
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
  if (strategyId === 'evil-panda' && !EVIL_PANDA_ENABLED) return 'EVIL_PANDA_ENABLED is not true'
  return null
}

// (old DAMM edge count removed)

function getScannerAdjustedScore(
  metrics: TokenMetrics,
  strategyId: string,
): number {
  if (strategyId !== 'evil-panda') return 0

  const w = EVIL_PANDA_SCANNER_SCORE_WEIGHTS
  const tw = w.freshness + w.rugcheck + w.holders + w.feeTvl1h + w.volumeTvl1h
  if (tw <= 0) return 0

  // Inline component scorers (evil-panda only path after simplification)
  const h = metrics.holderCount ?? 0
  const holderScore = (metrics.holderReliable ?? true)
    ? (h >= 5000 ? 100 : h >= 2000 ? 80 : h >= 1000 ? 65 : h >= 500 ? 45 : h >= 200 ? 25 : 10)
    : 0

  const age = metrics.ageHours ?? 0
  const freshnessScore = age <= 1.5 ? 100 : age <= 6 ? 85 : age <= 24 ? 70 : 55

  const f1 = metrics.feeTvl1hPct ?? 0
  const feeTvl1hScore = f1 >= 8 ? 100 : f1 >= 5 ? 85 : f1 >= 3 ? 65 : f1 >= 1.5 ? 40 : f1 >= 0.5 ? 20 : 0

  const v1 = metrics.volumeTvl1hRatio ?? 0
  const volumeTvl1hScore = v1 >= 1.5 ? 100 : v1 >= 1.0 ? 90 : v1 >= 0.5 ? 75 : v1 >= 0.2 ? 55 : v1 >= 0.1 ? 30 : 0

  const rugScore = Math.max(0, Math.min(100, metrics.rugcheckScore ?? 0))

  const weighted = (freshnessScore * w.freshness + rugScore * w.rugcheck + holderScore * w.holders + feeTvl1hScore * w.feeTvl1h + volumeTvl1hScore * w.volumeTvl1h) / tw
  return Math.round(Math.min(100, Math.max(0, weighted)))
}

// OOR recheck disabled in simplified model (local-state only for now)
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
    console.log('[scanner] tickMode=true — skipping (no open in tick mode)')
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

  // fetching Meteora pools (lane classification + deep checks below)
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
    minLiquidityUsd: 20_000,
    maxLiquidityUsd: 500_000_000,
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

  console.log('[scanner] checking position limits')

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
      console.warn(`[scanner] live position count incomplete (dlmmOk=${limitState.dlmmOk}) — using cached count`)
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

  console.log(`[scanner] deep-checking ${survivors.length} survivors`)
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

  for (const { pool: representativePool, ageHours, lane } of survivors) {
    await new Promise(r => setTimeout(r, DEEP_CHECK_DELAY_MS))

    const token = getTradableToken(representativePool)
    const tokenAddress = token.address
    const symbol = representativePool.name ?? token.symbol
    const launchpadSource = isPumpFunToken(tokenAddress) ? 'pumpfun' : isMoonshotToken(tokenAddress) ? 'moonshot' : 'meteora'
    const liveOpenPosition = findLiveOpenPosition(limitState, tokenAddress, representativePool.address)

    if (openedMintsThisTick.has(tokenAddress)) {
      console.log(`[scanner] ${symbol} — skip ${lane} lane: position already opened earlier this tick`)
      continue
    }

    if (CANDIDATE_DEDUP_HOURS > 0) {
      // Per-mint dedup is handled via local state below; no Supabase path.
    }

    if (liveOpenPosition) {
      console.log(`[scanner] ${symbol} — skip: live Meteora position already exists (${liveOpenPosition.position_pubkey})`)
      continue
    }

    // Per-mint dedup using local state (skip open or recent bad closes)
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

    // Pool selection (simple exact + fallback)
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

    // MC resolution (DexScreener fallback for low/stale Meteora data)
    // Prefer token's market_cap from Meteora if present, otherwise DexScreener
    let resolvedMc = token.market_cap || 0
    if (!resolvedMc || resolvedMc < 1) {
      resolvedMc = await withTimeout(
        fetchMcFromDexScreener(tokenAddress, token.price),
        EXTERNAL_CALL_TIMEOUT_MS,
        `fetchMcFromDexScreener ${symbol}`,
      ).then(v => v ?? 0)
    }
    if (!resolvedMc || resolvedMc < 1) {
      if (lane !== 'fresh') continue
      resolvedMc = 0
    }

    let holderCount = 0, topHolderPct = 0, holderReliable = false
    if (USE_HELIUS) {
      const h = await withTimeout(checkHolders(tokenAddress), EXTERNAL_CALL_TIMEOUT_MS, `checkHolders ${symbol}`)
      if (h) {
        holderCount = h.holderCount; topHolderPct = h.topHolderPct; holderReliable = h.reliable
        if (!h.reliable && token.holders) holderCount = Math.max(holderCount, token.holders)
      } else {
        holderCount = token.holders ?? 0
      }
    } else {
      holderCount = token.holders ?? 0
    }

    const rugScore = await withTimeout(getRugscore(tokenAddress, symbol), EXTERNAL_CALL_TIMEOUT_MS, `getRugscore ${symbol}`).then(v => v ?? 0)
    const holderCountForFilter = holderCount || (token.holders ?? 0)

    const bondingCurvePct: number | undefined =
      (isPumpFunToken(tokenAddress) && heliusRpcUrl && ageHours < 48)
        ? (await getCachedPumpFunBondingCurve(tokenAddress, heliusRpcUrl))?.progressPct
        : undefined

    const metrics: TokenMetrics = {
      address: tokenAddress, symbol,
      mcUsd: resolvedMc,
      liquidityUsd: getPoolTvl(bestPool),
      topHolderPct, holderCount: holderCountForFilter, holderReliable, ageHours,
      rugcheckScore: rugScore, priceUsd: token.price,
      poolAddress: bestPool.address, dexId: 'meteora',
      feeTvl24hPct: getFeeTvlPct(bestPool, '24h'),
      feeTvl1hPct: getFeeTvlPct(bestPool, '1h'),
      volume24h: getPoolVolume(bestPool, '24h'),
      volumeTvl1hRatio: getVolumeTvlRatio(bestPool, '1h'),
      quoteTokenMint: getQuoteTokenMint(bestPool),
      volume1h: getPoolVolume(bestPool, '1h'),
      volume5m: getPoolVolume(bestPool, '5m'),
      feeTvl5mPct: getFeeTvlPct(bestPool, '5m'),
      bondingCurvePct, launchpadSource,
      binStep: bestPool.pool_config?.bin_step,
      // dropped (not required by current evil-panda + persist + alerts): volumeGrowth1h, momentumScore
    }

    // Strategy: unified on evil-panda (lanes give basic momentum filtering)
    const strategy = getStrategyForToken(metrics, 'evil-panda')

    let decision = 'REJECTED'
    let rejectionReason: string | null = null
    let finalScore = 0

    if (!strategy) {
      rejectionReason = explainNoStrategy(metrics)
      decision = 'REJECTED'
      console.log(`[scanner][decision] ${symbol} — REJECTED (no strategy) lane=${lane}: ${rejectionReason}`)
    } else {
      finalScore = getScannerAdjustedScore(metrics, strategy.id)

      const meetsOpen = finalScore >= MIN_SCORE_TO_OPEN
      if (!meetsOpen) {
        rejectionReason = `score ${finalScore} < ${MIN_SCORE_TO_OPEN}`
        decision = 'REJECTED'
      } else {
        decision = 'ACCEPTED'
      }

      console.log(`[scanner][decision] ${symbol} — ${decision} (lane=${lane}, score=${finalScore})`)
    }

    if (decision === 'ACCEPTED' && strategy) {
      candidateCount++
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

        // Update local state with strategy/symbol
        try {
          const positions = getOpenLpPositions()
          const idx = positions.findIndex((p: any) => p.id === positionId)
          if (idx !== -1) {
            positions[idx].strategy_id = strategy.id
            positions[idx].symbol = symbol
            saveOpenLpPositions(positions)
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
        console.warn(`[scanner] ${symbol} — openPosition returned null (executor did not open despite ACCEPT)`)
      }
    }
  }

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

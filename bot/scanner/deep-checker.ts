import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

/**
 * Deep-check / decision layer — aligned to the revised bot filters spec (real fields only).
 *
 * Server-side list (per spec):
 *   GET /pools?sort_by=fee_tvl_ratio_1h:desc
 *        &filter_by=tvl>=500 && fee_24h>=5 && fee_tvl_ratio_24h>=0.005 && is_blacklisted=false
 *        &limit/page_size ~50 (small number of pages for bounded results)
 *
 * Client secondary derives (on the small result set):
 *   impliedActiveTVL = volume_1h / fee_pct   → 330..750000
 *   feeAccelerating = fee_1h > (fee_2h / 2)
 *   age > 2h (pool_created_at)
 *   (plus SOL-paired for this strategy)
 *
 * Expensive only on final ~top-5 survivors: lp_count (via getProgramAccounts / positions)
 * Then full deep gates (price deviation, Jupiter preflight, rug/holders, strategy filter, dedup, slots, etc.)
 * Enter the first viable ("#1 remaining").
 *
 * Kept improvements beyond the minimal spec: rich per-pool rejection logging, early SOL gate,
 * price vs market check, Jupiter route preflight for new Token-2022, full deep quality gates,
 * 0-new-bin-array range optimization on open, etc.
 */

import axios from 'axios'
// Local state only (no Supabase in hot paths)
import { getBotState } from '@/lib/botState'
import { getStrategyForToken, explainNoStrategy } from '@/strategies'
import { openPosition } from '../executor'
import { sendAlert } from '../alerter'
import { checkHolders } from '@/lib/helius'
import { getRugscore } from '../rugcheck-cache'
import {
  fetchBondingCurve,
  isPumpFunToken,
  isMoonshotToken,
} from '@/lib/pumpfun'
import type { TokenMetrics } from '@/lib/types'
import { OPEN_LP_STATUSES, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { getHeliusRpcEndpoint } from '@/lib/solana'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import { isDailyLossLimitHit } from '@/lib/circuit-breaker'
import { logInfo } from '@/lib/log'
import { getOpenLpPositions, saveOpenLpPositions } from '@/lib/local-state'
import { hasJupiterRouteSolToToken } from '@/lib/swap'
import {
  SCAN_INTERVAL_MS,
  SCANNER_TICK_TIMEOUT_MS,
  CANDIDATE_DEDUP_HOURS,
  OOR_RECHECK_HOURS,
  MAX_POOL_AGE_MINUTES,
  DEEP_CHECK_DELAY_MS,
  MAX_FRESH_DEEP_CHECKS,
  LP_SCANNER_ENABLED,
  EVIL_PANDA_ENABLED,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MARKET_LP_SOL_PER_POSITION,
  MAX_POOL_PRICE_DEVIATION,
  FRESH_MIN_TVL_USD,
  MIN_POOL_AGE_HOURS,
  MIN_LP_COUNT,
  MIN_IMPLIED_ACTIVE_TVL,
  MAX_IMPLIED_ACTIVE_TVL,
  MIN_FEE_TVL_RATIO_24H,
  ACTIVITY_MAX_POOL_AGE_MINUTES,
} from '@/lib/strategy-config'
import {
  fetchMeteoraPools,
  getFeeTvlPct,
  getPoolAgeMinutes,
  getPoolTvl,
  getPoolVolume,
  getQuoteTokenMint,
  getTradableToken,
  getVolumeTvlRatio,
  // activity top-performer getters + proxies
  getActiveTvlUsd,
  getTotalLps,
  getFeesActiveTvl24hPct,
  getTvlChange24h,
  getFeesChange24h,
  getImpliedActiveTvl,
  isFeeAccelerating,
  getUniqueLpCount,
  SOL_MINT,
} from './pool-fetcher'
import {
  filterActivityPools,
  selectTopCandidates,
  selectBestPool,
  selectTopByActiveYield,
} from './activity-candidate-filter'

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens'

const METEORA_FETCH_TIMEOUT_MS = 45_000
const EXTERNAL_CALL_TIMEOUT_MS = 8_000
const USE_HELIUS               = process.env.HELIUS_ENABLED === 'true'

// Re-export values needed by bot/scanner.ts
export {
  SCAN_INTERVAL_MS,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MARKET_LP_SOL_PER_POSITION,
  MAX_POOL_AGE_MINUTES,
  FRESH_MIN_TVL_USD,
  // Current activity model constants (real documented fields + derived proxies)
  MIN_POOL_AGE_HOURS,
  MIN_LP_COUNT,
  MIN_IMPLIED_ACTIVE_TVL,
  MAX_IMPLIED_ACTIVE_TVL,
  MIN_FEE_TVL_RATIO_24H,
  ACTIVITY_MAX_POOL_AGE_MINUTES,
} from '@/lib/strategy-config'

const _bondingCurveCache = new Map<string, { pct: number; complete: boolean | null; ts: number }>()
const BONDING_CACHE_TTL_MS = 10 * 60 * 1_000

type CachedBondingCurve = {
  progressPct: number
  complete: boolean | null
}

export type ScannerResult = {
  scanned: number
  candidates: number          // activity-qualified candidates (min age >2h + real API fields + derived proxies) that passed OOR dedup
  processed: number           // how many we actually deep-checked / decided on
  opened: number
  openSkipped: number
  openSlots: number
  maxOpen: number
  openCount?: number
  openBlockedReason?: string
  error?: string
  tickMode?: boolean
  apiPools?: number           // raw count returned by Meteora API before JS age/SOL-paired pre-filter (for observability)
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

// OOR recheck is a no-op stub (local-state only model)
async function fetchRecentlyClosedOorMints(): Promise<Set<string>> {
  if (OOR_RECHECK_HOURS <= 0) return new Set()
  return new Set()
}



/** Resolve SOL price in USD using DexScreener (free tier friendly, reliable for SOL).
 * Falls back to env var or 150.
 */
async function resolveSolPriceUsd(): Promise<number> {
  try {
    const res = await fetch(`${DEXSCREENER}/So11111111111111111111111111111111111111112`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const json = await res.json() as any
      const pairs = json?.pairs || []
      // Prefer stable quote for accurate SOL price
      const solPair = pairs.find((p: any) =>
        (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT') &&
        p.chainId === 'solana'
      ) || pairs[0]
      const price = parseFloat(solPair?.priceUsd || '0')
      if (price > 0) return price
    }
  } catch {}
  const envSolPrice = parseFloat(process.env.SOL_PRICE_USD ?? '')
  return Number.isFinite(envSolPrice) && envSolPrice > 0 ? envSolPrice : 150
}

let scannerRunPromise: Promise<ScannerResult> | null = null
let scannerRunStartedAt = 0

function emptyScannerResult(result: Partial<ScannerResult>): ScannerResult {
  const r: any = {
    scanned: 0,
    candidates: 0,
    processed: 0,
    opened: 0,
    openSkipped: 0,
    openSlots: 0,
    maxOpen: MAX_CONCURRENT_MARKET_LP_POSITIONS,
    ...result,
  }
  if (r.openBlockedReason === undefined) delete r.openBlockedReason
  if (r.error === undefined) delete r.error
  return r
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
    // Omit undefined optionals for cleaner structured logs (e.g. no "openBlockedReason: undefined")
    if ((fullResult as any).openBlockedReason === undefined) delete (fullResult as any).openBlockedReason
    if ((fullResult as any).error === undefined) delete (fullResult as any).error
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
      candidates: 0,
      processed: 0,
      opened: 0,
      openSkipped: 0,
      openBlockedReason: 'tick_mode_no_open',
    })
  }

  // === Aligned flow (per revised spec: real fields + server sort/filter where supported) ===
  // 1. Cheap targeted list call: server filter_by (tvl + fee_24h + fee_tvl_ratio_24h) + sort_by=fee_tvl_ratio_1h:desc (bounded pages)
  // 2. Client secondary derives on the (small) result: impliedActiveTVL (volume_1h/fee_pct), fee_1h > fee_2h/2, age>2h
  // 3. LP count (expensive) only on final ~top-5 survivors
  // 4. Deep quality gates + enter the first viable top performer ("#1 remaining")

  const activityConfig = {
    maxPoolAgeMinutes: ACTIVITY_MAX_POOL_AGE_MINUTES,
    maxCandidates: MAX_FRESH_DEEP_CHECKS,
  }

  // Targeted fetch using real API capabilities (much smaller result set)
  // Aligned to revised spec: server sort_by=fee_tvl_ratio_1h:desc + filter_by including fee_tvl_ratio_24h>=0.005
  const { pools: fetchedPools, error: fetchError, rawCount } = await fetchMeteoraPools({
    minTvlUsd: MIN_TVL_USD,
    limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '50'),
    timeoutMs: METEORA_FETCH_TIMEOUT_MS,
    maxPoolAgeMinutes: ACTIVITY_MAX_POOL_AGE_MINUTES,
    minLiquidityUsd: 0,
    maxLiquidityUsd: Number.MAX_SAFE_INTEGER,
    strictFeeTvlRatioFilter: true,
    sortBy: 'fee_tvl_ratio_1h:desc',
  })
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return finish({ error: fetchError, openBlockedReason: 'pool_fetch_failed' })
  }

  const apiCount = rawCount ?? fetchedPools.length
  console.log(`[scanner] fetched ${fetchedPools.length} pools from targeted API call (raw: ${apiCount})`)

  const activityCandidates = await selectEnrichAndPrepareCandidates(fetchedPools, activityConfig, rawCount)

  if (activityCandidates.length === 0) {
    return finish({ scanned: fetchedPools.length, candidates: 0, apiPools: rawCount })
  }

  console.log(`[scanner] processing ${activityCandidates.length} enriched top candidates (lp_count + deep gates)`)

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
    console.warn('[scanner] position limit check unavailable — refusing to open new positions')
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
        `source=${limitState.countSource}, live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount}) — refusing to open new positions`,
      )
    }
  }

  console.log(`[scanner] deep-checking ${activityCandidates.length} top activity candidates (by 24h fees/active yield)`)
  let candidateCount = 0
  let openedCount = 0
  let openSkippedCount = 0
  let dailyLossLimitHit: boolean | null = null
  const heliusRpcUrl = getHeliusRpcEndpoint() ?? ''
  const openedMintsThisTick = new Set<string>()

  // Pre-fetch live SOL price once per tick for accurate MC and position sizing
  const liveSolPriceUsd = await resolveSolPriceUsd()

  const tickContext: ScannerTickContext = {
    freshPools: activityCandidates, // passed through for selectBestPool / helpers (legacy field name)
    limitState,
    openBlockedReason,
    availableOpenSlots,
    openedMintsThisTick,
    heliusRpcUrl,
    liveSolPriceUsd,
    openedCount: { value: openedCount },
    openSkippedCount: { value: openSkippedCount },
    candidateCount: { value: candidateCount },
    dailyLossLimitHit: { value: dailyLossLimitHit },
  };

  for (const cand of activityCandidates) {
    await processActivityCandidate(cand, tickContext);
  }

  // Sync counters back from context
  openedCount = tickContext.openedCount.value;
  openSkippedCount = tickContext.openSkippedCount.value;
  candidateCount = tickContext.candidateCount.value;
  dailyLossLimitHit = tickContext.dailyLossLimitHit.value;

  // === Tick Summary for debuggability ===
  console.log(
    `[scanner] tick done — scanned=${fetchedPools.length}, activityCandidates=${activityCandidates.length}, ` +
    `processed=${candidateCount}, opened=${openedCount}, skipped=${openSkippedCount}`
  )

  // High-level summary (very useful when debugging why nothing happened this tick)
  console.log(
    `[scanner] summary — activity=${activityCandidates.length}, opened=${openedCount}, skipped=${openSkippedCount}, ` +
    `openSlots=${availableOpenSlots}, dailyLossHit=${dailyLossLimitHit ?? false}`
  )



  return finish({
    scanned: fetchedPools.length,
    candidates: activityCandidates.length,
    processed: candidateCount,
    opened: openedCount,
    openSkipped: openSkippedCount,
    openSlots: availableOpenSlots,
    openCount,
    openBlockedReason,
    apiPools: rawCount,
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

/**
 * Checks how much the Meteora pool's current price deviates from the external market price (via Dexscreener).
 * Returns the absolute relative deviation (e.g. 0.08 for 8%), or null if data unavailable.
 * This catches cases where the DLMM pool price is misaligned with broader market (common on very new/thin pools).
 */
async function getPoolVsMarketPriceDeviation(pool: any, mint: string): Promise<number | null> {
  try {
    const res = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 6_000 })
    const pairs: any[] = res.data?.pairs ?? []
    if (pairs.length === 0) return null

    // Prefer a SOL-quoted pair for direct comparison with Meteora current_price (which is typically in SOL)
    const solPair = pairs.find((p: any) => 
      (p.quoteToken?.symbol === 'SOL' || p.quoteToken?.address === 'So11111111111111111111111111111111111111112')
    ) || pairs[0]

    const externalPriceInSol = parseFloat(solPair?.priceNative || solPair?.priceUsd || '0')
    if (!externalPriceInSol || externalPriceInSol <= 0) return null

    const poolPriceInSol = pool.current_price
    if (!poolPriceInSol || poolPriceInSol <= 0) return null

    const deviation = Math.abs(poolPriceInSol - externalPriceInSol) / externalPriceInSol
    return deviation
  } catch {
    return null
  }
}

type ActivityCandidateProcessResult = {
  wasCandidate: boolean;
  wasOpened: boolean;
  wasSkipped: boolean;
};

interface ScannerTickContext {
  freshPools: any[];  // legacy field name for helpers
  limitState: any;
  openBlockedReason: string | undefined;
  availableOpenSlots: number;
  openedMintsThisTick: Set<string>;
  heliusRpcUrl: string;
  liveSolPriceUsd: number;

  // Mutable counters (passed by ref via object)
  openedCount: { value: number };
  openSkippedCount: { value: number };
  candidateCount: { value: number };
  dailyLossLimitHit: { value: boolean | null };
}

/**
 * Fetches with real API filters, applies derived proxies, selects top 5 by 1h yield,
 * enriches with lp_count on survivors (expensive step only here).
 */
async function selectEnrichAndPrepareCandidates(
  fetchedPools: any[],
  activityConfig: any,
  rawCount: number | undefined
): Promise<any[]> {
  // The updated applyJsPreFilter (called inside fetchMeteoraPools) already applied:
  // server filters + age>2h + implied active (volume/flow) + fee acceleration + SOL
  const { activityPools: qualified } = filterActivityPools(fetchedPools, activityConfig)

  console.log(`[scanner] ${qualified.length} pools passed real documented fields + derived proxies (implied_active, fee_accel, age>2h, fee_tvl_24h>=0.5%)`)

  if (qualified.length > 0) {
    const names = qualified.slice(0, 8).map((p: any) => p.name).join(', ')
    console.log(`[scanner] top qualified by fee_tvl_1h: ${names}${qualified.length > 8 ? ' ...' : ''}`)
  }

  const recentlyClosedOorMints = await fetchRecentlyClosedOorMints()
  let activityCandidates = selectTopCandidates(qualified, recentlyClosedOorMints, activityConfig)

  // Sort by recency (fee_tvl_1h) as recommended
  activityCandidates.sort((a, b) => getFeeTvlPct(b.pool, '1h') - getFeeTvlPct(a.pool, '1h'))

  // Take top 5 per spec
  activityCandidates = activityCandidates.slice(0, 5)

  if (activityCandidates.length === 0) {
    console.log('[scanner] done — no candidates after real-field filters + proxies')
    return []
  }

  // Enrich only the final survivors with lp_count (the expensive step)
  console.log(`[scanner] enriching lp_count for ${activityCandidates.length} final survivors (Helius or RPC)`)
  for (const cand of activityCandidates) {
    const lpCount = await getUniqueLpCount(cand.pool.address)
    if (lpCount > 0) {
      (cand.pool as any)._enriched_lp_count = lpCount
      if (lpCount < MIN_LP_COUNT) {
        console.log(`[scanner][enrich] ${cand.pool.name} lp_count=${lpCount} < ${MIN_LP_COUNT} — will be soft-filtered in deep checks`)
      }
    } else {
      console.warn(`[scanner][enrich] ${cand.pool.name} lp_count=0 (Helius/RPC failed or no positions — LP gate is soft-pass for this pool)`)
    }
  }

  return activityCandidates
}

/**
 * Processes one of the top activity-qualified candidates.
 */
async function processActivityCandidate(
  cand: { pool: any; ageHours: number },
  ctx: ScannerTickContext
): Promise<ActivityCandidateProcessResult> {
  const {
    freshPools,
    limitState,
    openBlockedReason,
    availableOpenSlots,
    openedMintsThisTick,
    heliusRpcUrl,
    liveSolPriceUsd,
    openedCount: openedCountRef,
    openSkippedCount: openSkippedCountRef,
    candidateCount: candidateCountRef,
    dailyLossLimitHit: dailyLossLimitHitRef,
  } = ctx;

  const { pool: representativePool, ageHours } = cand;

  await new Promise(r => setTimeout(r, DEEP_CHECK_DELAY_MS));

  const token = getTradableToken(representativePool);
  const tokenAddress = token.address;
  const symbol = representativePool.name ?? token.symbol;
  const label = `[scanner][${symbol}]`;

  console.log(`${label} processing activity top-performer candidate (age=${ageHours.toFixed(1)}h, yield24h≈${getFeesActiveTvl24hPct(representativePool).toFixed(2)}%)`);

  // Early gate for evil-panda: must be SOL-paired (we only do one-sided SOL LP via Zap/direct).
  // This is belt-and-suspenders with the JS pre-filter.
  const p = representativePool;
  const isSolPaired = p.token_x?.address === SOL_MINT || p.token_y?.address === SOL_MINT;
  if (!isSolPaired) {
    console.log(`${label} skip: no SOL side (evil-panda strategy is SOL-paired one-sided only; got ${p.token_x?.symbol || p.token_x?.address?.slice(0,4)}/${p.token_y?.symbol || p.token_y?.address?.slice(0,4)})`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  // LP count gate (only reliable on enriched survivors)
  const enrichedLp = (p as any)._enriched_lp_count || 0;
  if (enrichedLp > 0 && enrichedLp < MIN_LP_COUNT) {
    console.log(`${label} skip: lp_count=${enrichedLp} < ${MIN_LP_COUNT} (derived from positions)`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  const launchpadSource: 'pumpfun' | 'moonshot' | 'meteora' | 'dbc' = isPumpFunToken(tokenAddress) ? 'pumpfun' : isMoonshotToken(tokenAddress) ? 'moonshot' : 'meteora';
  const liveOpenPosition = findLiveOpenPosition(limitState, tokenAddress, representativePool.address);

  if (openedMintsThisTick.has(tokenAddress)) {
    console.log(`${label} skip: position already opened earlier this tick`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  if (CANDIDATE_DEDUP_HOURS > 0) {
    // Per-mint dedup is handled via local state below; no Supabase path.
  }

  if (liveOpenPosition) {
    console.log(`${label} skip: live Meteora position already exists (${liveOpenPosition.position_pubkey})`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  const conflicting = findConflictingLocalPosition(tokenAddress);
  if (conflicting) {
    if (OPEN_LP_STATUSES.includes(conflicting.status)) {
      console.log(`${label} skip: existing open LP position for mint (id=${conflicting.id})`);
    } else {
      console.log(`${label} skip: recent bad close for this mint (id=${conflicting.id}, reason=${conflicting.close_reason})`);
    }
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  // Pool selection: When multiple tiers exist for the same token among the top activity candidates,
  // pick the one with the best 24h fee/tvl (on total TVL, as a secondary tie-breaker).
  const result = selectBestPool(freshPools, tokenAddress);
  const bestPool = result.pool;

  const tokenPools = freshPools.filter(p =>
    getTradableToken(p)?.address === tokenAddress
  );
  if (tokenPools.length > 1 && bestPool) {
    console.log(`[scanner] ${symbol} — multiple pools for token, selected best by 24h Fee/TVL`);
  }

  if (!bestPool) {
    console.log(`${label} skip: no pool found for token`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  // Pre-open quality check: skip if the DLMM pool's spot price is significantly misaligned with external market.
  // This is the condition behind the ">5% pool price differs from market price" warning on Meteora UI.
  // Opening around a mispriced active bin often leads to immediate OOR or poor IL when price corrects.
  const priceDev = await getPoolVsMarketPriceDeviation(bestPool, tokenAddress);
  if (priceDev !== null && priceDev > MAX_POOL_PRICE_DEVIATION) {
    console.log(`${label} skip: pool price deviates ${(priceDev * 100).toFixed(1)}% from external market (threshold ${(MAX_POOL_PRICE_DEVIATION * 100)}%)`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  // Jupiter buyability pre-flight (critical for Token-2022 live opens).
  // The manual initialize+add path requires acquiring the output token via Jupiter first.
  // Ultra-fresh Token-2022 graduates frequently return "No routes found" until Jupiter
  // indexes the new DLMM pool / on-chain liquidity. We skip early (before ACCEPT) so we
  // don't burn an open slot + produce loud errors. Scanner will re-evaluate on next tick
  // while the pool is still within the activity window (age > 2h).
  const canBuyToken = await withTimeout(
    hasJupiterRouteSolToToken(tokenAddress, '50000000', 1000),
    8000,
    `jupiter-route ${symbol}`
  );
  if (canBuyToken !== true) {
    console.log(`${label} skip: no Jupiter route for SOL → ${symbol} (NO_ROUTES_FOUND or quote error at test size; common on brand-new Token-2022 graduates — will retry next scan if still fresh)`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  const liveBestPoolPosition = findLiveOpenPosition(limitState, tokenAddress, bestPool.address);
  if (liveBestPoolPosition) {
    console.log(`${label} skip: live Meteora position already exists for best pool (${liveBestPoolPosition.position_pubkey})`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }

  // MC resolution
  let resolvedMc = token.market_cap || 0;
  if (!resolvedMc || resolvedMc < 1) {
    resolvedMc = await withTimeout(
      fetchMcFromDexScreener(tokenAddress, token.price),
      EXTERNAL_CALL_TIMEOUT_MS,
      `fetchMcFromDexScreener ${symbol}`,
    ).then(v => v ?? 0);
  }
  if (!resolvedMc || resolvedMc < 1) {
    resolvedMc = 0;
  }

  let holderCount = 0, topHolderPct = 0, holderReliable = false;
  if (USE_HELIUS) {
    const h = await withTimeout(checkHolders(tokenAddress), EXTERNAL_CALL_TIMEOUT_MS, `checkHolders ${symbol}`);
    if (h) {
      holderCount = h.holderCount; topHolderPct = h.topHolderPct; holderReliable = h.reliable;
      if (!h.reliable && token.holders) holderCount = Math.max(holderCount, token.holders);
    } else {
      holderCount = token.holders ?? 0;
    }
  } else {
    holderCount = token.holders ?? 0;
  }

  const rugScore = await withTimeout(getRugscore(tokenAddress, symbol), EXTERNAL_CALL_TIMEOUT_MS, `getRugscore ${symbol}`).then(v => v ?? 0);
  const rugcheckUrl = `https://rugcheck.xyz/tokens/${tokenAddress}`;
  const holderCountForFilter = holderCount || (token.holders ?? 0);

  const bondingCurvePct: number | undefined =
    (isPumpFunToken(tokenAddress) && heliusRpcUrl && ageHours < 48)
      ? (await getCachedPumpFunBondingCurve(tokenAddress, heliusRpcUrl))?.progressPct
      : undefined;

  const metrics = buildTokenMetrics({
    tokenAddress,
    symbol,
    resolvedMc,
    bestPool,
    topHolderPct,
    holderCountForFilter,
    holderReliable,
    ageHours,
    rugScore,
    rugcheckUrl,
    token,
    launchpadSource,
    bondingCurvePct,
    poolPriceDeviation: priceDev ?? undefined,
  });

  const { strategy, decision, rejectionReason } = evaluateCandidate(metrics, symbol);

  if (decision === 'ACCEPTED' && strategy) {
    return await attemptOpenAndNotify({
      metrics,
      strategy,
      symbol,
      liveSolPriceUsd,
      openedMintsThisTick,
      openedCountRef,
      openSkippedCountRef,
      dailyLossLimitHitRef,
      openBlockedReason,
      availableOpenSlots,
      candidateCountRef,
    });
  }

  return { wasCandidate: false, wasOpened: false, wasSkipped: true };
}

async function attemptOpenAndNotify(params: {
  metrics: TokenMetrics;
  strategy: any;
  symbol: string;
  liveSolPriceUsd: number;
  openedMintsThisTick: Set<string>;
  openedCountRef: { value: number };
  openSkippedCountRef: { value: number };
  dailyLossLimitHitRef: { value: boolean | null };
  openBlockedReason: string | undefined;
  availableOpenSlots: number;
  candidateCountRef: { value: number };
}): Promise<ActivityCandidateProcessResult> {
  const {
    metrics,
    strategy,
    symbol,
    liveSolPriceUsd,
    openedMintsThisTick,
    openedCountRef,
    openSkippedCountRef,
    dailyLossLimitHitRef,
    openBlockedReason,
    availableOpenSlots,
    candidateCountRef: candidateCountRefParam,
  } = params;

  const label = `[scanner][${symbol}]`;

  candidateCountRefParam.value++;
  await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score: 0, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct: metrics.bondingCurvePct });

  const disabledReason = getDisabledStrategyReason(strategy.id);
  if (disabledReason) {
    openSkippedCountRef.value++;
    console.log(`${label} open skipped: ${disabledReason}`);
    return { wasCandidate: true, wasOpened: false, wasSkipped: true };
  }
  if (openBlockedReason || openedCountRef.value >= availableOpenSlots) {
    openSkippedCountRef.value++;
    console.log(`${label} open skipped: ${openBlockedReason ?? 'no_slots'}`);
    return { wasCandidate: true, wasOpened: false, wasSkipped: true };
  }

  // Daily loss check using the ref (no closure dependency)
  if (!dailyLossLimitHitRef.value) {
    const hit = await isDailyLossLimitHit();
    dailyLossLimitHitRef.value = hit;
    if (hit) {
      openSkippedCountRef.value++;
      console.log(`${label} open skipped: daily loss circuit breaker`);
      return { wasCandidate: true, wasOpened: false, wasSkipped: true };
    }
  }

  const positionId = await openPosition(metrics, strategy);
  if (positionId) {
    openedCountRef.value++;
    dailyLossLimitHitRef.value = null;
    openedMintsThisTick.add(metrics.address);

    console.log(`${label} LP position opened ✔ (id=${positionId})`);

    patchOpenPositionMetadata(positionId, strategy.id, symbol);

    return { wasCandidate: true, wasOpened: true, wasSkipped: false };
  } else {
    openSkippedCountRef.value++;
    console.warn(`[scanner] ${symbol} — openPosition returned null (executor did not open despite ACCEPT)`);
    await sendAlert({ type: 'warning', message: `Open failed for ${symbol} (executor returned null after ACCEPT — likely Jupiter buy or on-chain tx error; see worker logs)` });
    return { wasCandidate: true, wasOpened: false, wasSkipped: true };
  }
}

function evaluateCandidate(
  metrics: TokenMetrics,
  symbol: string
) {
  const strategy = getStrategyForToken(metrics, 'evil-panda');

  if (!strategy) {
    const rejectionReason = explainNoStrategy(metrics);
    console.log(`[scanner][decision] ${symbol} — REJECTED (no strategy): ${rejectionReason}`);
    return { strategy: null, decision: 'REJECTED', rejectionReason, finalScore: 0 };
  }

  // If it passed the real documented fields + derived proxies (tvl + fee_24h server-side, implied active, fee accel, age > 2h) + deep gates,
  // we accept (subject to limits etc.). Final selection is the top survivor after lp_count enrichment on candidates.
  console.log(`[scanner][decision] ${symbol} — ACCEPTED (top performer via real API fields + derivations, no scoring)`);

  return { strategy, decision: 'ACCEPTED', rejectionReason: null, finalScore: 0 };
}

function findConflictingLocalPosition(tokenAddress: string) {
  const recentClosedCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const allPositions = getOpenLpPositions();

  return allPositions.find((p: any) => {
    if (p.mint !== tokenAddress) return false;
    if (OPEN_LP_STATUSES.includes(p.status)) return true;
    if (p.status === 'closed' && p.closed_at && p.closed_at >= recentClosedCutoff) {
      const reason = p.close_reason || '';
      if (reason.startsWith('pnl_unavailable') || reason.startsWith('bad')) return true;
    }
    return false;
  });
}

/**
 * Patches strategy_id + symbol onto a freshly persisted open LP position in local state.
 * This is a transitional patch because the core persist/open path does not yet receive these fields.
 * Small dedicated helper so the hot path stays readable.
 */
function patchOpenPositionMetadata(positionId: string, strategyId: string, symbol: string): void {
  try {
    const positions = getOpenLpPositions();
    const idx = positions.findIndex((p: any) => p.id === positionId);
    if (idx !== -1) {
      positions[idx].strategy_id = strategyId;
      positions[idx].symbol = symbol;
      saveOpenLpPositions(positions);
    }
  } catch {}
}

function buildTokenMetrics(params: {
  tokenAddress: string;
  symbol: string;
  resolvedMc: number;
  bestPool: any;
  topHolderPct: number;
  holderCountForFilter: number;
  holderReliable: boolean;
  ageHours: number;
  rugScore: number;
  rugcheckUrl?: string;
  token: any;
  launchpadSource?: 'pumpfun' | 'moonshot' | 'meteora' | 'dbc'; // DBC 0.2.0+ may bring transfer-hook tokens
  bondingCurvePct?: number;
  poolPriceDeviation?: number | null;
}): TokenMetrics {
  const {
    tokenAddress,
    symbol,
    resolvedMc,
    bestPool,
    topHolderPct,
    holderCountForFilter,
    holderReliable,
    ageHours,
    rugScore,
    rugcheckUrl,
    token,
    launchpadSource,
    bondingCurvePct,
    poolPriceDeviation,
  } = params;

  return {
    address: tokenAddress,
    symbol,
    mcUsd: resolvedMc,
    liquidityUsd: getPoolTvl(bestPool),
    topHolderPct,
    holderCount: holderCountForFilter,
    holderReliable,
    ageHours,
    rugcheckScore: rugScore,
    rugcheckUrl,
    priceUsd: token.price,
    poolAddress: bestPool.address,
    dexId: 'meteora',
    feeTvl24hPct: getFeeTvlPct(bestPool, '24h'),
    feeTvl1hPct: getFeeTvlPct(bestPool, '1h'),
    volume24h: getPoolVolume(bestPool, '24h'),
    volumeTvl1hRatio: getVolumeTvlRatio(bestPool, '1h'),
    quoteTokenMint: getQuoteTokenMint(bestPool),
    volume1h: getPoolVolume(bestPool, '1h'),
    volume5m: getPoolVolume(bestPool, '5m'),
    feeTvl5mPct: getFeeTvlPct(bestPool, '5m'),
    bondingCurvePct,
    launchpadSource,
    binStep: bestPool.pool_config?.bin_step,
    poolPriceDeviation: poolPriceDeviation ?? undefined,
  };
}

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
 * Score survivors (feeTvl 1h/24h + lpCountNorm) and open highest-scored first.
 * Ranking log now includes raw components (1h, 24h, lpNorm) for observability.
 *
 * Note: Some older FRESH_* constants remain exported for compatibility but are not used in the active path.
 * See strategy-config.ts for details — active path uses real API fields + MIN_TVL_USD etc.
 *
 * Kept improvements beyond the minimal spec: rich per-pool rejection logging, early SOL gate,
 * price vs market check, Jupiter route preflight for new Token-2022, full deep quality gates,
 * 0-new-bin-array range optimization on open, etc.
 */

import axios from 'axios'
// Local state only (JSON files in state/ + targeted on-chain reads)
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
// Jupiter preflight removed - direct Meteora DLMM swap used for pre-swap now
import { resolveSolPriceUsd } from '@/lib/sol-price'
import { computePoolScore } from './pool-metrics'
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
  MIN_TVL_USD,
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
} from './activity-candidate-filter'

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens'

const METEORA_FETCH_TIMEOUT_MS = 45_000
const EXTERNAL_CALL_TIMEOUT_MS = 8_000

// Shared DexScreener response cache (per mint) to eliminate duplicate calls in the same tick.
// fetchMcFromDexScreener + getPoolVsMarketPriceDeviation were hitting the same endpoint independently.
const dexScreenerCache = new Map<string, { pairs: any[]; ts: number }>()
const DEX_CACHE_TTL_MS = 15_000

async function getDexScreenerPairs(mint: string): Promise<any[]> {
  const hit = dexScreenerCache.get(mint)
  if (hit && (Date.now() - hit.ts) < DEX_CACHE_TTL_MS) return hit.pairs
  try {
    const res = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 6_000 })
    const pairs: any[] = res.data?.pairs ?? []
    dexScreenerCache.set(mint, { pairs, ts: Date.now() })
    return pairs
  } catch {
    return []
  }
}
const USE_HELIUS               = process.env.HELIUS_ENABLED === 'true'

// Re-export values needed by bot/scanner.ts
export {
  SCAN_INTERVAL_MS,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MARKET_LP_SOL_PER_POSITION,
  MAX_POOL_AGE_MINUTES,
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

// OOR recheck is intentionally a no-op stub in the current local-state-only model.
// OOR recheck is a no-op with pure local JSON state (no cross-restart history by default).
// If OOR_RECHECK_HOURS > 0 in future, a real impl can scan recent closed positions in local state.
async function fetchRecentlyClosedOorMints(): Promise<Set<string>> {
  if (OOR_RECHECK_HOURS <= 0) return new Set()
  return new Set()
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
  // 4. Deep quality gates on survivors, then score + rank by composite (feeTvl 1h/24h + lpCountNorm) before opening

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
    EXTERNAL_CALL_TIMEOUT_MS,
    'open LP limit state (local)',
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

  // Array to collect candidates that pass all deep gates. We pass it via ctx
  // so processActivityCandidate (module-level function) can push to it.
  // After the loop we score + sort descending and open in that order.
  const deepGateSurvivors: any[] = [];

  const tickContext: ScannerTickContext = {
    freshPools: activityCandidates, // wrapped for selectBestPool helpers (we normalize inside)
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
    deepGateSurvivors,
  };

  for (const cand of activityCandidates) {
    await processActivityCandidate(cand, tickContext);
  }

  // Sync counters back from context
  openedCount = tickContext.openedCount.value;
  openSkippedCount = tickContext.openSkippedCount.value;
  candidateCount = tickContext.candidateCount.value;
  dailyLossLimitHit = tickContext.dailyLossLimitHit.value;

  // === Score deep-gate survivors and open in descending score order ===
  // All candidates have now passed (or failed) the full set of deep gates
  // (SOL-paired, lp_count min, no conflicts, pool-vs-market price dev, Jupiter preflight,
  // holders/rug, strategy match, etc.). We score only the survivors and re-sort so the
  // single best composite score always gets the first open slot (and subsequent slots
  // if available), instead of whichever one happened to appear first in the input order.
  if (deepGateSurvivors.length > 0) {
    const scoredSurvivors = deepGateSurvivors
      .map((s: any) => {
        const breakdown = computePoolScore(s.pool, s.lpCount);
        return {
          ...s,
          ...breakdown,
        };
      })
      .sort((a: any, b: any) => b.score - a.score);

    console.log(
      `[scanner] ${scoredSurvivors.length} deep survivors ranked by score (highest first): ` +
        scoredSurvivors
          .map(
            (s: any) =>
              `${s.symbol}(${s.score.toFixed(4)} ` +
              `1h=${s.feeTvlRatio1h.toFixed(4)} 24h=${s.feeTvlRatio24h.toFixed(4)} lpNorm=${s.lpCountNorm.toFixed(2)})`
          )
          .join(' > ')
    );

    // Only attempt the single best (top-ranked) survivor per scanner tick.
    // This prevents "purchasing" (pre-swapping the token leg for) 4-5 different tokens in one cycle
    // when earlier attempts fail to open a position (e.g. transient realloc, balance, etc.).
    // With MAX_CONCURRENT=1, we want at most one pre-swap + open attempt per 15min tick.
    // If the best one fails, next tick will re-evaluate the (new) top candidate.
    // The attemptOpenAndNotify still does all the per-attempt slot/daily-loss/dedup checks.
    if (scoredSurvivors.length > 0) {
      const top = scoredSurvivors[0];
      console.log(`[scanner] attempting single top-ranked open this tick (best score first; no cascade on failure)`);
      await attemptOpenAndNotify({
        metrics: top.metrics,
        strategy: top.strategy,
        symbol: top.symbol,
        liveSolPriceUsd: top.liveSolPriceUsd,
        openedMintsThisTick: top.openedMintsThisTick,
        openedCountRef: top.openedCountRef,
        openSkippedCountRef: top.openSkippedCountRef,
        dailyLossLimitHitRef: top.dailyLossLimitHitRef,
        openBlockedReason: top.openBlockedReason,
        availableOpenSlots: top.availableOpenSlots,
        candidateCountRef: top.candidateCountRef,
        score: top.score,
      });
    }
  }

  // Re-sync counters (ranked open attempts may have mutated the boxed refs)
  candidateCount = tickContext.candidateCount.value;
  openedCount = tickContext.openedCount.value;
  openSkippedCount = tickContext.openSkippedCount.value;
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
  const pairs = await getDexScreenerPairs(mint)
  if (pairs.length === 0) return 0
  return pairs[0].marketCap ?? pairs[0].fdv ?? 0
}

/**
 * Checks how much the Meteora pool's current price deviates from the external market price (via Dexscreener).
 * Returns the absolute relative deviation (e.g. 0.08 for 8%), or null if data unavailable.
 * This catches cases where the DLMM pool price is misaligned with broader market (common on very new/thin pools).
 */
async function getPoolVsMarketPriceDeviation(pool: any, mint: string): Promise<number | null> {
  const pairs = await getDexScreenerPairs(mint)
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
}

type ActivityCandidateProcessResult = {
  wasCandidate: boolean;
  wasOpened: boolean;
  wasSkipped: boolean;
};

interface ScannerTickContext {
  freshPools: any[];  // field name for helpers (historical)
  limitState: any;
  openBlockedReason: string | undefined;
  availableOpenSlots: number;
  openedMintsThisTick: Set<string>;
  heliusRpcUrl: string;
  liveSolPriceUsd: number;

  // Mutable counters (passed by ref via boxed objects).
  // This pattern allows processActivityCandidate (and sub-calls like attemptOpenAndNotify)
  // to mutate shared tick state without complex return values or closures.
  // Used for openedCount, openSkippedCount, candidateCount, dailyLossLimitHit.
  // (Style debt noted; works reliably for the current sequential processing.)
  openedCount: { value: number };
  openSkippedCount: { value: number };
  candidateCount: { value: number };
  dailyLossLimitHit: { value: boolean | null };

  // For collecting deep survivors so we can score + rank after all gates (passed via ctx to avoid scope issues)
  deepGateSurvivors: any[];
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
    // Show a deduped-by-mint view in the log (multiple tiers per token can pass filters)
    const seenForLog = new Set<string>()
    const displayNames: string[] = []
    for (const p of qualified) {
      const mint = getTradableToken(p)?.address
      if (mint && seenForLog.has(mint)) continue
      if (mint) seenForLog.add(mint)
      displayNames.push(p.name)
      if (displayNames.length >= 8) break
    }
    console.log(`[scanner] top qualified by fee_tvl_1h: ${displayNames.join(', ')}${qualified.length > displayNames.length ? ' ...' : ''}`)
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
  console.log(`[scanner] enriching lp_count for ${activityCandidates.length} final survivors (Helius getProgramAccounts)`)
  for (const cand of activityCandidates) {
    const lpCount = await getUniqueLpCount(cand.pool.address)
    if (lpCount > 0) {
      (cand.pool as any)._enriched_lp_count = lpCount
      if (lpCount < MIN_LP_COUNT) {
        console.log(`[scanner][enrich] ${cand.pool.name} lp_count=${lpCount} < ${MIN_LP_COUNT} — will be soft-filtered in deep checks`)
      } else {
        console.log(`[scanner][enrich] ${cand.pool.name} lp_count=${lpCount} (meets MIN_LP_COUNT)`)
      }
    }
    // When 0 we rely on the detailed logs from inside getUniqueLpCount (no key / query returned 0 accounts / error)
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
    deepGateSurvivors,
  } = ctx;

  const { pool: representativePool, ageHours } = cand;

  await new Promise(r => setTimeout(r, DEEP_CHECK_DELAY_MS));

  const token = getTradableToken(representativePool);
  const symbol = representativePool?.name ?? token?.symbol ?? 'unknown';
  const label = `[scanner][${symbol}]`;

  if (!token) {
    console.log(`${label} skip: malformed pool (no tradable token side)`);
    return { wasCandidate: false, wasOpened: false, wasSkipped: true };
  }
  const tokenAddress = token.address;

  console.log(`${label} processing activity top-performer candidate (age=${ageHours.toFixed(1)}h, yield24h≈${getFeesActiveTvl24hPct(representativePool).toFixed(2)}%)`);

  // Early gate for evil-panda: must be SOL-paired (we only do one-sided SOL LP via direct SDK after pre-swap).
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

  // Normalize because freshPools may contain ActivityCandidate wrappers.
  const tokenPools = (Array.isArray(freshPools) ? freshPools : [])
    .map((item: any) => item?.pool ?? item)
    .filter((p: any) => getTradableToken(p)?.address === tokenAddress);

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

  // Jupiter pre-flight removed (Jupiter ditched completely).
  // Pre-swap now uses direct Meteora DLMM swap (native on the target pool).
  // Direct swap will succeed or fail at open time for these range-qualified pools.

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

  const { strategy, decision, rejectionReason } = await evaluateCandidate(metrics, symbol);

  if (decision === 'ACCEPTED' && strategy) {
    // Range feasibility for evil-panda is now enforced inside evaluateCandidate (before we ever
    // log "ACCEPTED"). This prevents "ACCEPTED" followed by a range skip in the logs, which was
    // confusing for expected "we only open full -50/+100 with zero rent" behavior.
    //
    // Only pools that passed every gate (including full range) reach here and get ranked.
    const poolForScore = bestPool || representativePool;
    const lpCountForScore = (poolForScore as any)._enriched_lp_count || 0;
    deepGateSurvivors.push({
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
      pool: poolForScore,
      lpCount: lpCountForScore,
    });
    return { wasCandidate: true, wasOpened: false, wasSkipped: true };
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
  score?: number; // actual composite score from ranking (for alerts / logs)
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
    score = 0,
  } = params;

  const label = `[scanner][${symbol}]`;

  candidateCountRefParam.value++;
  await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct: metrics.bondingCurvePct });

  const disabledReason = getDisabledStrategyReason(strategy.id);
  if (disabledReason) {
    openSkippedCountRef.value++;
    console.log(`${label} open skipped: ${disabledReason}`);
    return { wasCandidate: true, wasOpened: false, wasSkipped: true };
  }

  // Fresh re-check of current open count / slots right before attempting the open.
  // This closes the window where limitState was captured before the ranked loop and
  // previous awaits in the same tick (or external activity) have consumed slots.
  // Combined with the re-check inside openPosition itself, this prevents double-spend races.
  let effectiveAvailable = availableOpenSlots;
  try {
    const fresh = await getOpenLpLimitState('market').catch(() => null);
    if (fresh) {
      const currOpen = fresh.effectiveOpenCount || 0;
      effectiveAvailable = Math.max(0, MAX_CONCURRENT_MARKET_LP_POSITIONS - currOpen);
      if (effectiveAvailable <= 0 || currOpen >= MAX_CONCURRENT_MARKET_LP_POSITIONS) {
        openSkippedCountRef.value++;
        console.log(`${label} open skipped: no fresh slots (current=${currOpen}/${MAX_CONCURRENT_MARKET_LP_POSITIONS})`);
        return { wasCandidate: true, wasOpened: false, wasSkipped: true };
      }
    }
  } catch {}

  if (openBlockedReason || openedCountRef.value >= effectiveAvailable) {
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

    // Note: strategy_id + symbol are now written directly in persistPosition (persistence.ts).
    // The previous transitional patchOpenPositionMetadata has been removed.

    return { wasCandidate: true, wasOpened: true, wasSkipped: false };
  } else {
    openSkippedCountRef.value++;
    // openPosition returns null for many *intentional* reasons (range gate for full -50/+100 with 0 new bin arrays,
    // fresh balance/slot re-checks, no SOL side, etc.) as well as technical failures (swap 0x177e, SDK open error).
    // The detailed reason is always logged by the executor right before returning null.
    // We no longer treat every null as a scary "technical failure".
    console.log(`${label} openPosition returned null — see the [executor][${strategy.id}][${symbol}] logs immediately above for the exact reason (range gate, balance, slots, swap failure, etc.)`);
    // Only send a Telegram warning for cases that are likely real errors (the executor already logs loudly for those).
    // The generic "despite ACCEPT" message was too alarming when the skip was by design (e.g. full range not free).
    return { wasCandidate: true, wasOpened: false, wasSkipped: true };
  }
}

async function evaluateCandidate(
  metrics: TokenMetrics,
  symbol: string
) {
  const strategy = getStrategyForToken(metrics, 'evil-panda');

  if (!strategy) {
    const rejectionReason = explainNoStrategy(metrics);
    console.log(`[scanner][decision] ${symbol} — REJECTED (no strategy): ${rejectionReason}`);
    return { strategy: null, decision: 'REJECTED', rejectionReason, finalScore: 0 };
  }

  // Evil-panda core requirement: full desired range must be possible with zero new bin arrays.
  // Check this here (before logging ACCEPTED) so we never say "ACCEPTED" for pools that
  // cannot support the strategy's full -50%/+100% Bid-Ask range. This keeps logs and any
  // downstream notifications clean for expected design-driven skips.
  if (strategy.id === 'evil-panda') {
    try {
      console.log(`[scanner][${symbol}] [TRACE] [RANGE-GATE] running early checkFullEvilPandaRangeFeasibility before ACCEPT`);
      const { checkFullEvilPandaRangeFeasibility } = await import('../executor/open');
      const { getConnection } = await import('@/lib/solana');
      const { PublicKey } = await import('@solana/web3.js');
      const rangeCheck = await checkFullEvilPandaRangeFeasibility(
        getConnection(),
        new PublicKey(metrics.poolAddress || metrics.address),
        strategy.position?.rangeDownPct ?? -50,
        strategy.position?.rangeUpPct ?? 100
      );
      console.log(`[scanner][${symbol}] [TRACE] [RANGE-GATE] feasible=${rangeCheck.feasible} newArrays=${rangeCheck.newBinArrayCount} totalBins=${rangeCheck.totalBins}`);
      if (!rangeCheck.feasible) {
        console.log(
          `[scanner][${symbol}] SKIPPING (range gate): full evil-panda range (-50% / +100%) not free with 0 new bin arrays ` +
          `(${rangeCheck.newBinArrayCount} new array(s) for ${rangeCheck.totalBins} bins, step=${rangeCheck.binStep}). ` +
          `This is expected behavior — we only open when the complete discrete range is already populated on-chain (no rent).`
        );
        return { strategy: null, decision: 'REJECTED', rejectionReason: 'full evil-panda range requires new bin arrays', finalScore: 0 };
      }
      console.log(`[scanner][${symbol}] [TRACE] [RANGE-GATE] ✅ passed early zero-new-bin-array verification`);
    } catch (e) {
      console.warn(`[scanner][${symbol}] [TRACE] [RANGE-GATE] range feasibility check in evaluate failed (will let later gates decide):`, e);
      console.warn(`[scanner][${symbol}] range feasibility check in evaluate failed (will let later gates decide):`, e);
    }
  }

  // If it passed the real documented fields + derived proxies (tvl + fee_24h server-side, implied active, fee accel, age > 2h) + deep gates,
  // we accept (subject to limits etc.). Final selection among survivors is done by composite score ranking (see ranking log).
  console.log(`[scanner][decision] ${symbol} — ACCEPTED (top performer via real API fields + derivations; will be ranked by score for open priority)`);

  return { strategy, decision: 'ACCEPTED', rejectionReason: null, finalScore: 0 };
}

function findConflictingLocalPosition(tokenAddress: string) {
  const dedupMs = Math.max(0, CANDIDATE_DEDUP_HOURS) * 60 * 60 * 1000;
  const recentClosedCutoff = new Date(Date.now() - dedupMs).toISOString();
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

import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

/**
 * Ultra-minimal deep-check / decision layer (age-only model).
 *
 * - Hard gate: pool age ≤ MAX_POOL_AGE_MINUTES (30 by default)
 * - Very light pre-filter (only basic TVL floor + must have SOL/USDC/USDT quote)
 * - No fee/TVL or volume/TVL requirements in the hot path
 * - No scoring, no momentum lanes
 * - Best pool per token chosen by highest 24h Fee/TVL
 * - Then deep-check enrichment + accept (if fresh) → open + Moonboy
 *
 * Rugcheck + holders are fetched only for rich Telegram notifications (informational).
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
  MAX_POOL_AGE_MINUTES,
  DEEP_CHECK_DELAY_MS,
  MAX_FRESH_DEEP_CHECKS,
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
  getTradableToken,
  getVolumeTvlRatio,
} from './pool-fetcher'
import {
  filterFreshPools,
  selectFreshCandidates,
  selectBestPool,
} from './fresh-pool-filter'

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens'

const METEORA_FETCH_TIMEOUT_MS = 45_000
const EXTERNAL_CALL_TIMEOUT_MS = 8_000
const USE_HELIUS               = process.env.HELIUS_ENABLED === 'true'

// Re-export values needed by bot/scanner.ts
export { SCAN_INTERVAL_MS, MAX_CONCURRENT_MARKET_LP_POSITIONS, MARKET_LP_SOL_PER_POSITION, MAX_POOL_AGE_MINUTES } from '@/lib/strategy-config'

const _bondingCurveCache = new Map<string, { pct: number; complete: boolean | null; ts: number }>()
const BONDING_CACHE_TTL_MS = 10 * 60 * 1_000

type CachedBondingCurve = {
  progressPct: number
  complete: boolean | null
}

export type ScannerResult = {
  scanned: number
  candidates: number          // fresh candidates that passed age + OOR dedup
  processed: number           // how many we actually deep-checked / decided on
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

// OOR recheck is a no-op stub (local-state only model)
async function fetchRecentlyClosedOorMints(): Promise<Set<string>> {
  if (OOR_RECHECK_HOURS <= 0) return new Set()
  return new Set()
}

/**
 * Attempt a Moonboy companion spot-buy ($10) right after a successful LP open.
 * This is the single authoritative trigger point for Moonboy.
 *
 * In the minimal model the scanner already only considers fresh tokens (≤ MAX_POOL_AGE_MINUTES),
 * so we do not re-apply a separate age gate here.
 */
async function triggerMoonboyOnCandidate(
  metrics: TokenMetrics, 
  solPriceUsd: number
): Promise<void> {
  const isDryRun = process.env.BOT_DRY_RUN === 'true'
  const label = `[moonboy][${metrics.symbol}]`

  console.log(`${label} evaluating Moonboy on fresh candidate (age=${metrics.ageHours.toFixed(1)}h)`);

  if (!moonboyStrategy.enabled) {
    console.log(`${label} skipped — Moonboy strategy disabled`);
    return
  }

  // Note: The main scanner already enforces age ≤ MAX_POOL_AGE_MINUTES.
  // We keep this secondary check only as a safety net for standalone Moonboy paths.
  const maxAge = moonboyStrategy.filters.maxAgeHours
  if (metrics.ageHours > maxAge) {
    console.log(`${label} skipped — age ${metrics.ageHours.toFixed(1)}h > ${maxAge}h gate (Moonboy max age)`);
    return
  }

  console.log(`${label} triggering companion spot-buy on fresh candidate (age=${metrics.ageHours.toFixed(1)}h)`)

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
  return {
    scanned: 0,
    candidates: 0,
    processed: 0,
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
      candidates: 0,
      processed: 0,
      opened: 0,
      openSkipped: 0,
      openBlockedReason: 'tick_mode_no_open',
    })
  }

  // fetching Meteora pools — ultra-minimal model (Option B)
  // Primary gate is age (MAX_POOL_AGE_MINUTES) + basic sanity only.
  // No meaningful fee/TVL or volume/TVL requirements in the pre-filter.
  // Highest-liquidity pool selection + the new filterFreshPools/selectFreshCandidates
  // are the real decision logic.
  const freshConfig = {
    maxPoolAgeMinutes: MAX_POOL_AGE_MINUTES,
    maxCandidates: MAX_FRESH_DEEP_CHECKS,
  }

  // Ultra-minimal scanner fetch: **Only the age gate**.
  // No TVL, liquidity, fee/TVL or volume filters are applied at fetch time.
  const { pools: fetchedPools, error: fetchError } = await fetchMeteoraPools({
    minTvlUsd: 0,
    limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '1200'),
    timeoutMs: METEORA_FETCH_TIMEOUT_MS,
    maxPoolAgeMinutes: MAX_POOL_AGE_MINUTES,
    minLiquidityUsd: 0,
    maxLiquidityUsd: Number.MAX_SAFE_INTEGER,
  })
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return finish({ error: fetchError, openBlockedReason: 'pool_fetch_failed' })
  }

  const { freshPools, candidates } =
    filterFreshPools(fetchedPools, freshConfig)

  console.log(
    `[scanner] fresh candidates (age ≤ ${MAX_POOL_AGE_MINUTES}m): ${freshPools.length} (from ${fetchedPools.length} pools)`
  )

  const recentlyClosedOorMints = await fetchRecentlyClosedOorMints()
  const freshCandidates = selectFreshCandidates(candidates, recentlyClosedOorMints, freshConfig)

  if (freshCandidates.length === 0) {
    console.log('[scanner] done — no fresh candidates after age filter')
    return finish({ scanned: fetchedPools.length, candidates: 0 })
  }

  console.log(`[scanner] processing ${freshCandidates.length} fresh candidates (age ≤ ${MAX_POOL_AGE_MINUTES}m)`)

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

  console.log(`[scanner] deep-checking ${freshCandidates.length} candidates`)
  let candidateCount = 0
  let openedCount = 0
  let openSkippedCount = 0
  let dailyLossLimitHit: boolean | null = null
  const heliusRpcUrl = getHeliusRpcEndpoint() ?? ''
  const openedMintsThisTick = new Set<string>()

  // Pre-fetch live SOL price once per tick for accurate MC and position sizing
  const liveSolPriceUsd = await resolveSolPriceUsd()

  const tickContext: ScannerTickContext = {
    freshPools,
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

  for (const cand of freshCandidates) {
    await processFreshCandidate(cand, tickContext);
  }

  // Sync counters back from context
  openedCount = tickContext.openedCount.value;
  openSkippedCount = tickContext.openSkippedCount.value;
  candidateCount = tickContext.candidateCount.value;
  dailyLossLimitHit = tickContext.dailyLossLimitHit.value;

  // === Tick Summary for debuggability ===
  console.log(
    `[scanner] tick done — scanned=${fetchedPools.length}, candidates=${freshCandidates.length}, ` +
    `processed=${candidateCount}, opened=${openedCount}, skipped=${openSkippedCount}`
  )

  // High-level summary (very useful when debugging why nothing happened this tick)
  console.log(
    `[scanner] summary — fresh=${freshCandidates.length}, opened=${openedCount}, skipped=${openSkippedCount}, ` +
    `openSlots=${availableOpenSlots}, dailyLossHit=${dailyLossLimitHit ?? false}`
  )

  // Moonboy summary (now triggered on candidates, not just LP opens)
  // (logged via the per-candidate Moonboy logs above + this aggregate if we tracked more)

  return finish({
    scanned: fetchedPools.length,
    candidates: freshCandidates.length,
    processed: candidateCount,
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

type FreshCandidateProcessResult = {
  wasCandidate: boolean;
  wasOpened: boolean;
  wasSkipped: boolean;
};

interface ScannerTickContext {
  freshPools: any[];
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
 * Processes a single fresh candidate (age ≤ MAX_POOL_AGE_MINUTES).
 * Extracted for readability. Uses a context object to reduce parameter count.
 */
async function processFreshCandidate(
  cand: { pool: any; ageHours: number },
  ctx: ScannerTickContext
): Promise<FreshCandidateProcessResult> {
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

  console.log(`${label} processing fresh candidate (age=${ageHours.toFixed(1)}h)`);
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

  // Pool selection: When multiple tiers exist for a token, we prefer highest 24h Fee/TVL
  const result = selectBestPool(freshPools, tokenAddress);
  const bestPool = result.pool;

  // Optional observability for multiple pools
  const tokenPools = freshPools.filter(p =>
    getTradableToken(p)?.address === tokenAddress
  );
  if (tokenPools.length > 1 && bestPool) {
    const chosenTvl = getPoolTvl(bestPool);
    console.log(`[scanner] ${symbol} — multiple pools for token (${tokenPools.length}), selected highest 24h Fee/TVL pool`);
  }

  if (!bestPool) {
    console.log(`${label} skip: no pool found for token`);
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
}): Promise<FreshCandidateProcessResult> {
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

  // Moonboy is triggered on every fresh candidate the scanner picks up
  // (independent of whether an LP position is actually opened).
  void triggerMoonboyOnCandidate(metrics, liveSolPriceUsd);

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

  // In the ultra-minimal model we no longer score for the opening decision.
  // If we reached here after the age filter, we accept (subject to position limits etc.).
  console.log(`[scanner][decision] ${symbol} — ACCEPTED (fresh, no scoring)`);

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
  };
}

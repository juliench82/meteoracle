import { withTimeout } from './deep-checker'
import { createServerClient } from '@/lib/supabase'
import { getOpenDammEdgeCount } from './metrics'
import { evaluateDammEdge } from '@/strategies/damm-edge'
import { openDammPosition, resolveVerifiedDammV2PoolForToken } from '../damm-executor'
import { sendAlert } from '../alerter'
import { openMoonboyPosition } from '../moonboy-executor'
import { moonboyStrategy } from '@/strategies/moonboy'
import { WSOL } from './pool-fetcher'
import type { TokenMetrics } from '@/lib/types'

const SUPABASE_TIMEOUT_MS = 10_000
const EXTERNAL_CALL_TIMEOUT_MS = 8_000
const MAX_CONCURRENT_DAMM_POSITIONS = 2

async function maybeTriggerMoonboy(metrics: TokenMetrics, solPriceUsd: number): Promise<void> {
  if (!moonboyStrategy.enabled) return
  if (metrics.ageHours > moonboyStrategy.filters.maxAgeHours) {
    console.log(
      `[moonboy] ${metrics.symbol} — skip: age ${metrics.ageHours.toFixed(1)}h > ` +
      `${moonboyStrategy.filters.maxAgeHours}h gate`,
    )
    return
  }
  try {
    const moonboyId = await openMoonboyPosition(metrics, solPriceUsd)
    if (moonboyId) {
      console.log(`[moonboy] ${metrics.symbol} — spot-buy opened alongside LP (id=${moonboyId})`)
    }
  } catch (err) {
    console.warn(
      `[moonboy] ${metrics.symbol} — openMoonboyPosition threw (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

export async function handleDammEdge(
  lane: string,
  launchpadSource: string,
  tokenAddress: string,
  metrics: TokenMetrics,
  openBlockedReason: string | undefined,
  openedCount: number,
  availableOpenSlots: number,
  openedDammCountThisTick: number,
  dailyLossLimitHit: boolean | null,
  isOpenAllowedToday: () => Promise<boolean>,
  openedMintsThisTick: Set<string>,
  liveSolPriceUsd: number,
): Promise<{ opened: boolean; openedDammCountThisTick: number; dailyLossLimitHit: boolean | null }> {
  if (lane !== 'fresh' || launchpadSource !== 'meteora' || process.env.DAMM_EDGE_ENABLED !== 'true') {
    return { opened: false, openedDammCountThisTick, dailyLossLimitHit }
  }

  const dammDecision = await evaluateDammEdge(tokenAddress, metrics)
  console.log(`[scanner][damm-edge] ${metrics.symbol}: ${dammDecision.reason}`)

  if (!dammDecision.shouldUseDamm || !dammDecision.params) {
    return { opened: false, openedDammCountThisTick, dailyLossLimitHit }
  }

  if (openBlockedReason || openedCount >= availableOpenSlots) {
    console.log(`[scanner][damm-edge] ${metrics.symbol} qualifies but DAMM open skipped: ${openBlockedReason ?? 'slots_filled_this_tick'}`)
    return { opened: false, openedDammCountThisTick, dailyLossLimitHit }
  }

  if (!await isOpenAllowedToday()) {
    console.log(`[scanner][damm-edge] ${metrics.symbol} qualifies but DAMM open skipped: daily loss circuit breaker`)
    return { opened: false, openedDammCountThisTick, dailyLossLimitHit }
  }

  const openDammCount = getOpenDammEdgeCount(null) + openedDammCountThisTick
  if (openDammCount >= MAX_CONCURRENT_DAMM_POSITIONS) {
    console.log(`[scanner][damm-edge] max DAMM positions reached (${openDammCount}/${MAX_CONCURRENT_DAMM_POSITIONS})`)
    return { opened: false, openedDammCountThisTick, dailyLossLimitHit }
  }

  const verifiedDammPool = await withTimeout(
    resolveVerifiedDammV2PoolForToken({ tokenAddress, quoteMint: WSOL }),
    EXTERNAL_CALL_TIMEOUT_MS,
    `resolveVerifiedDammV2PoolForToken ${metrics.symbol}`,
  )

  if (!verifiedDammPool) {
    console.log(`[scanner][damm-edge] ${metrics.symbol} has no verified DAMM v2 SOL pool`)
    return { opened: false, openedDammCountThisTick, dailyLossLimitHit }
  }

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

  console.log(`[scanner][damm-edge] TRIGGERED — opening verified DAMM v2 position for ${metrics.symbol}`)
  const result = await openDammPosition(dammParams)

  if (result.success) {
    openedDammCountThisTick++
    dailyLossLimitHit = null
    openedMintsThisTick.add(tokenAddress)
    void maybeTriggerMoonboy(metrics, liveSolPriceUsd)
    await sendAlert({
      type: 'position_opened',
      symbol: metrics.symbol,
      strategy: 'damm-edge',
      solDeposited: dammParams.solAmount,
      entryPrice: metrics.priceUsd,
      positionId: result.positionId ?? result.positionPubkey,
      poolAddress: verifiedDammPool.poolAddress,
      mint: tokenAddress,
    })
    return { opened: true, openedDammCountThisTick, dailyLossLimitHit }
  }

  console.error(`[scanner][damm-edge] openDammPosition failed for ${metrics.symbol}: ${result.error}`)
  return { opened: false, openedDammCountThisTick, dailyLossLimitHit }
}

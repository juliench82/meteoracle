import { createServerClient } from '@/lib/supabase'
import { openPosition, closePosition } from '@/bot/executor'
import { sendAlert } from '@/bot/alerter'
import { STRATEGIES } from '@/strategies'
import { syncAllMeteoraPositions } from '@/lib/position-sync'
import type { Strategy, TokenMetrics } from '@/lib/types'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

type LpPositionRow = Record<string, any>

export interface RebalanceHealth {
  ok: boolean
  reason?: string
  feeTvl24hPct: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  binStep: number | null
}

export interface RebalanceResult {
  success: boolean
  closed: boolean
  reopened: boolean
  oldPositionId: string
  newPositionId: string | null
  symbol: string
  strategyId: string | null
  reason: string
  error?: string
  health?: RebalanceHealth
}

export interface RebalanceOptions {
  reason?: string
  source?: string
  position?: LpPositionRow
  liveSourceOk?: boolean
  skipSync?: boolean
  allowHealthBypass?: boolean
}

function isDammLp(pos: LpPositionRow): boolean {
  return pos.strategy_id === 'damm-edge' || pos.strategy_id === 'damm-live' || pos.position_type === 'damm-edge'
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function numberFromMetadata(metadata: Record<string, unknown>, keys: string[]): number | null {
  return firstFiniteNumber(...keys.map(key => metadata[key]))
}

function feeTvlFromMetadata(metadata: Record<string, unknown>): number | null {
  const direct = numberFromMetadata(metadata, [
    'fee_tvl_24h_pct',
    'feeTvl24hPct',
    'daily_fee_yield',
    'fee_24h_tvl_pct',
  ])
  if (direct !== null) return direct

  const feeApr24h = numberFromMetadata(metadata, ['fee_apr_24h'])
  return feeApr24h !== null ? feeApr24h / 365 : null
}

function strategyForPosition(pos: LpPositionRow): Strategy | null {
  const strategyId = pos.strategy_id ?? pos.metadata?.strategy_id
  return STRATEGIES.find(strategy => strategy.id === strategyId) ?? null
}

function quoteMintForPosition(pos: LpPositionRow): string | undefined {
  const metadata = (pos.metadata ?? {}) as Record<string, unknown>
  const tokenX = String(metadata.token_x_mint ?? '')
  const tokenY = String(metadata.token_y_mint ?? '')
  const mint = String(pos.mint ?? pos.token_address ?? '')

  if (tokenX && tokenY) {
    if (tokenX === mint) return tokenY
    if (tokenY === mint) return tokenX
    if (tokenX === SOL_MINT) return tokenX
    if (tokenY === SOL_MINT) return tokenY
  }

  return typeof metadata.quote_token_mint === 'string'
    ? metadata.quote_token_mint
    : undefined
}

function evaluateRebalanceHealth(pos: LpPositionRow, strategy: Strategy): RebalanceHealth {
  const metadata = (pos.metadata ?? {}) as Record<string, unknown>
  const feeTvl24hPct = feeTvlFromMetadata(metadata)
  const volume24hUsd = numberFromMetadata(metadata, [
    'volume_24h_usd',
    'volume24hUsd',
    'volume_24h',
    'volume24h',
  ])
  const liquidityUsd = numberFromMetadata(metadata, [
    'dex_liquidity_usd',
    'tvl_usd',
    'liquidity_usd',
    'liquidityUsd',
  ])
  const binStep = firstFiniteNumber(metadata.bin_step, pos.bin_step)

  const reasons: string[] = []
  if (feeTvl24hPct === null) reasons.push('missing 24h fee/TVL')
  else if (feeTvl24hPct < strategy.filters.minFeeTvl24hPct) {
    reasons.push(`fee/TVL ${feeTvl24hPct.toFixed(2)}% < ${strategy.filters.minFeeTvl24hPct}%`)
  }

  if (volume24hUsd === null) reasons.push('missing 24h volume')
  else if (volume24hUsd < strategy.filters.minVolume24h) {
    reasons.push(`volume $${volume24hUsd.toFixed(0)} < $${strategy.filters.minVolume24h}`)
  }

  if (liquidityUsd === null) reasons.push('missing liquidity')
  else if (liquidityUsd < strategy.filters.minLiquidityUsd) {
    reasons.push(`liquidity $${liquidityUsd.toFixed(0)} < $${strategy.filters.minLiquidityUsd}`)
  }

  if (strategy.filters.minBinStep !== undefined) {
    if (binStep === null) reasons.push('missing bin step')
    else if (binStep < strategy.filters.minBinStep) {
      reasons.push(`binStep ${binStep} < ${strategy.filters.minBinStep}`)
    }
  }

  return {
    ok: reasons.length === 0,
    reason: reasons.join('; ') || undefined,
    feeTvl24hPct,
    volume24hUsd,
    liquidityUsd,
    binStep,
  }
}

function metricsForRebalance(pos: LpPositionRow, strategy: Strategy, health: RebalanceHealth): TokenMetrics {
  const metadata = (pos.metadata ?? {}) as Record<string, unknown>
  const ageHours = pos.opened_at
    ? Math.max(0, (Date.now() - new Date(pos.opened_at).getTime()) / 3_600_000)
    : 0

  return {
    address: String(pos.mint ?? pos.token_address),
    symbol: String(pos.symbol ?? 'LP'),
    mcUsd: firstFiniteNumber(metadata.market_cap_usd, metadata.mc_usd, metadata.mcUsd) ?? 0,
    volume24h: health.volume24hUsd ?? 0,
    liquidityUsd: health.liquidityUsd ?? 0,
    topHolderPct: firstFiniteNumber(metadata.top_holder_pct, metadata.topHolderPct) ?? 0,
    holderCount: firstFiniteNumber(metadata.holder_count, metadata.holderCount) ?? strategy.filters.minHolderCount,
    ageHours,
    rugcheckScore: firstFiniteNumber(metadata.rugcheck_score, metadata.rugcheckScore) ?? strategy.filters.minRugcheckScore,
    priceUsd: firstFiniteNumber(metadata.dex_price_usd, pos.entry_price_usd) ?? 0,
    poolAddress: String(pos.pool_address),
    dexId: String(metadata.dexId ?? metadata.dex_id ?? 'meteora'),
    feeTvl24hPct: health.feeTvl24hPct ?? 0,
    quoteTokenMint: quoteMintForPosition(pos),
    binStep: health.binStep ?? undefined,
  }
}

async function fetchPosition(positionId: string): Promise<LpPositionRow | null> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('lp_positions')
    .select('*')
    .eq('id', positionId)
    .single()

  if (error || !data) return null
  return data
}

async function logRebalance(event: string, payload: Record<string, unknown>): Promise<void> {
  await createServerClient()
    .from('bot_logs')
    .insert({ level: event.endsWith('_failed') || event.endsWith('_skipped') ? 'warn' : 'info', event, payload })
    .then(undefined, () => {})
}

export async function rebalanceDlmmPosition(
  positionId: string,
  options: RebalanceOptions = {},
): Promise<RebalanceResult> {
  const reason = options.reason ?? 'manual_rebalance'
  const source = options.source ?? 'unknown'

  let position = options.position ?? null
  let liveSourceOk = options.liveSourceOk

  if (!position && !options.skipSync) {
    try {
      const sync = await syncAllMeteoraPositions()
      liveSourceOk = sync.dlmmOk
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        closed: false,
        reopened: false,
        oldPositionId: positionId,
        newPositionId: null,
        symbol: 'unknown',
        strategyId: null,
        reason,
        error: `Meteora sync failed: ${error}`,
      }
    }
  }

  if (liveSourceOk === false) {
    return {
      success: false,
      closed: false,
      reopened: false,
      oldPositionId: positionId,
      newPositionId: null,
      symbol: position?.symbol ?? 'unknown',
      strategyId: position?.strategy_id ?? null,
      reason,
      error: 'DLMM live source is not healthy',
    }
  }

  position = position ?? await fetchPosition(positionId)
  if (!position) {
    return {
      success: false,
      closed: false,
      reopened: false,
      oldPositionId: positionId,
      newPositionId: null,
      symbol: 'unknown',
      strategyId: null,
      reason,
      error: 'position not found in Supabase cache',
    }
  }

  const symbol = String(position.symbol ?? 'LP')
  const strategy = strategyForPosition(position)
  const strategyId = strategy?.id ?? String(position.strategy_id ?? position.metadata?.strategy_id ?? '')

  if (position.status === 'closed') {
    return { success: false, closed: false, reopened: false, oldPositionId: positionId, newPositionId: null, symbol, strategyId, reason, error: 'position is already closed' }
  }
  if (isDammLp(position)) {
    return { success: false, closed: false, reopened: false, oldPositionId: positionId, newPositionId: null, symbol, strategyId, reason, error: 'rebalance is only supported for DLMM positions' }
  }
  if (!strategy) {
    return { success: false, closed: false, reopened: false, oldPositionId: positionId, newPositionId: null, symbol, strategyId: strategyId || null, reason, error: `strategy ${strategyId || 'unknown'} not found` }
  }

  const health = evaluateRebalanceHealth(position, strategy)
  if (!health.ok && !options.allowHealthBypass) {
    await logRebalance('rebalance_skipped', { positionId, symbol, strategy: strategy.id, source, reason, health })
    return {
      success: false,
      closed: false,
      reopened: false,
      oldPositionId: positionId,
      newPositionId: null,
      symbol,
      strategyId: strategy.id,
      reason,
      health,
      error: health.reason ?? 'pool health check failed',
    }
  }

  const closed = await closePosition(positionId, reason)
  if (!closed) {
    await logRebalance('rebalance_close_failed', { positionId, symbol, strategy: strategy.id, source, reason })
    return { success: false, closed: false, reopened: false, oldPositionId: positionId, newPositionId: null, symbol, strategyId: strategy.id, reason, health, error: 'close failed' }
  }

  const metrics = metricsForRebalance(position, strategy, health)
  const newPositionId = await openPosition(metrics, strategy, {
    rebalanceFromPositionId: positionId,
  })

  if (!newPositionId) {
    await logRebalance('rebalance_reopen_failed', { positionId, symbol, strategy: strategy.id, source, reason, health })
    return { success: false, closed: true, reopened: false, oldPositionId: positionId, newPositionId: null, symbol, strategyId: strategy.id, reason, health, error: 'reopen failed after close' }
  }

  await logRebalance('rebalance_completed', { positionId, newPositionId, symbol, strategy: strategy.id, source, reason, health })
  await sendAlert({
    type: 'position_rebalanced',
    symbol,
    strategy: strategy.id,
    reason,
    oldPositionId: positionId,
    newPositionId,
    feeTvl24hPct: health.feeTvl24hPct ?? undefined,
    volume24hUsd: health.volume24hUsd ?? undefined,
    liquidityUsd: health.liquidityUsd ?? undefined,
  })

  return { success: true, closed: true, reopened: true, oldPositionId: positionId, newPositionId, symbol, strategyId: strategy.id, reason, health }
}

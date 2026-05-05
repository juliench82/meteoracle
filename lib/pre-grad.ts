/**
 * lib/pre-grad.ts — DAMM v2 position lifecycle handler.
 *
 * Manages the monitoring loop and exit routing for positions opened via the
 * DAMM tracks (strategy_id = 'damm-edge' or 'damm-migration').
 *
 * ISOLATION RULE: Must NOT import anything from bot/monitor.ts or bot/executor.ts.
 *
 * SOURCE OF TRUTH RULE: Meteora API is the source of truth for all money fields.
 * We never compute PnL locally. We store snapshots from Meteora at close time.
 */

import { closeDammPosition } from '../bot/damm-executor'
import { sendAlert } from '../bot/alerter'
import { createServerClient } from './supabase'
import {
  fetchLiveMeteoraPositions,
  mergeDbAndLiveLpPositions,
  type LiveMeteoraPosition,
} from './meteora-live'
import { OPEN_LP_STATUSES } from './position-limits'
import { getRpcEndpointCandidates } from './solana'
import { summarizeError } from './logging'
import {
  getDammSolPriceFromPoolState,
  normalizeRawPoolPriceToSolPerToken,
  type DammSolPrice,
} from './damm-price'

const MANAGED_DAMM_IDS = ['pre_grad', 'pre-grad', 'damm-edge', 'damm-migration', 'damm-launch']
const MANAGED_DAMM_DB_POSITION_TYPES = ['pre_grad', 'pre-grad', 'damm-edge', 'damm-migration', 'damm-launch']
const MANAGED_DAMM_STRATEGIES = new Set(MANAGED_DAMM_IDS)
const MANAGED_DAMM_POSITION_TYPES = new Set(MANAGED_DAMM_IDS)

type DammPositionState = DammSolPrice & {
  currentPriceSol: number
}

function isManagedDammPosition(position: { strategy_id?: string | null; position_type?: string | null }): boolean {
  return MANAGED_DAMM_STRATEGIES.has(String(position.strategy_id ?? '')) ||
    MANAGED_DAMM_POSITION_TYPES.has(String(position.position_type ?? ''))
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = nullableNumber(value)
    if (n !== null) return n
  }
  return null
}

function roundPct(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

function getDammExitEntryPriceSol(
  position: {
    id?: string
    strategy_id?: string | null
    position_type?: string | null
    entry_price_sol?: unknown
    metadata?: Record<string, unknown> | null
  },
  onChain: DammPositionState,
): { value: number; source: string } | null {
  const metadata = metadataRecord(position.metadata)
  const entryPrice = finitePositive(position.entry_price_sol)
  if (entryPrice === null) return null

  const entryBasis = String(metadata.entry_price_basis ?? metadata.price_basis ?? '')
  if (entryBasis === 'sol_per_token' || entryBasis === 'sol-per-token') {
    return { value: entryPrice, source: 'entry_price_sol' }
  }

  const normalizedEntryPrice = normalizeRawPoolPriceToSolPerToken(entryPrice, onChain)
  return normalizedEntryPrice !== null
    ? { value: normalizedEntryPrice, source: 'entry_price_sol(raw-normalized)' }
    : null
}

function getRpcUrl(): string {
  const url = getRpcEndpointCandidates()[0]
  if (!url) throw new Error('RPC_URL, HELIUS_RPC_URL, or HELIUS_API_KEY is not set')
  return url
}

// ── DAMM v2 REST: pool stats ──────────────────────────────────────────────────

/**
 * Pool-level stats from the Meteora DAMM v2 REST API.
 * Used for dashboard context (volume, TVL) — not an exit signal.
 *
 * Endpoint: GET https://amm-v2.meteora.ag/pool/{pool_address}
 */
async function fetchDammPoolStats(poolAddress: string): Promise<{
  volume24hUsd: number
  tvlUsd: number
} | null> {
  try {
    const res = await fetch(`https://amm-v2.meteora.ag/pool/${poolAddress}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      volume24hUsd: Number(data.trading_volume ?? data.volume_24h ?? 0),
      tvlUsd:       Number(data.pool_tvl        ?? data.tvl        ?? 0),
    }
  } catch {
    return null
  }
}

// ── DAMM v2 REST: per-position live fields ────────────────────────────────────

/**
 * Fetches both claimable fees (USD) and current position value (USD) for a
 * specific position pubkey from Meteora's REST API.
 *
 * Meteora is the source of truth for both numbers — no local computation.
 *
 * Endpoint: GET https://damm-v2.datapi.meteora.ag/position/{position_pubkey}
 * Fields:
 *   fee_pending_usd    — claimable fees, mirrors Meteora UI
 *   position_value_usd — current value of token amounts at current price
 *
 * Returns null on any failure — non-blocking.
 */
async function fetchMeteoraPosFields(positionPubkey: string): Promise<{
  claimableFeesUsd: number | null
  positionValueUsd: number | null
  pnlUsd: number | null
  pnlPct: number | null
  costBasisUsd: number | null
} | null> {
  const endpoints = [
    `https://damm-v2.datapi.meteora.ag/position/${positionPubkey}`,
    `https://amm-v2.meteora.ag/position/${positionPubkey}`,
  ]
  try {
    let data: any = null
    for (const endpoint of endpoints) {
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(3_000),
      })
      if (!res.ok) continue
      data = await res.json()
      break
    }
    if (!data) return null

    const claimableFeesUsd =
      data.fee_pending_usd ?? data.total_fee_usd ?? data.claimable_fee_usd ?? null

    const positionValueUsd =
      data.position_value_usd ?? data.total_value_usd ?? data.value_usd ?? null

    const pnlUsd =
      data.pnl_usd ?? data.position_pnl_usd ?? data.total_pnl_usd ?? null

    const pnlPct =
      data.pnl_pct ?? data.position_pnl_pct ?? data.total_pnl_pct ??
      data.pnl_percentage ?? data.position_pnl_percentage ?? data.total_pnl_percentage ?? null

    const costBasisUsd =
      data.cost_basis_usd ?? data.total_deposit_usd ?? data.deposit_usd ?? data.position_cost_usd ?? null

    return {
      claimableFeesUsd: claimableFeesUsd !== null ? Number(claimableFeesUsd) : null,
      positionValueUsd: positionValueUsd !== null ? Number(positionValueUsd) : null,
      pnlUsd: pnlUsd !== null ? Number(pnlUsd) : null,
      pnlPct: pnlPct !== null ? Number(pnlPct) : null,
      costBasisUsd: costBasisUsd !== null ? Number(costBasisUsd) : null,
    }
  } catch {
    return null
  }
}

function resolveDammPnlPct(
  pos: Record<string, any>,
  onChainPnlPct: number | null,
  onChainPnlUsd: number | null,
  positionValueUsd: number | null,
  onChainCostBasisUsd: number | null,
): number | null {
  const metadata = metadataRecord(pos.metadata)
  const explicitPct = firstNumber(
    onChainPnlPct,
    pos.pnl_pct,
    metadata.pnl_pct,
    metadata.position_pnl_pct,
    metadata.position_pnl_percentage,
    metadata.pnl_percentage,
    metadata.total_pnl_pct,
    metadata.total_pnl_percentage,
  )
  if (explicitPct !== null) return explicitPct

  const pnlUsd = firstNumber(
    onChainPnlUsd,
    pos.pnl_usd,
    metadata.pnl_usd,
    metadata.position_pnl_usd,
    metadata.total_pnl_usd,
  )

  const costBasisUsd = firstNumber(
    onChainCostBasisUsd,
    metadata.meteora_total_deposit_usd,
    metadata.total_deposit_usd,
    metadata.deposit_usd,
    metadata.cost_basis_usd,
  )

  if (pnlUsd !== null && costBasisUsd !== null && costBasisUsd > 0) {
    return roundPct((pnlUsd / costBasisUsd) * 100)
  }

  if (positionValueUsd !== null && costBasisUsd !== null && costBasisUsd > 0) {
    return roundPct(((positionValueUsd - costBasisUsd) / costBasisUsd) * 100)
  }

  return null
}

// ── On-chain state fetch ──────────────────────────────────────────────────────

/**
 * Reads current sqrtPrice from DAMM pool state.
 * Used only for exit signal evaluation (stop-loss / take-profit price thresholds).
 * NOT used for PnL display — Meteora REST is the source of truth for that.
 */
async function fetchDammPositionState(
  poolAddress: string,
): Promise<DammPositionState | null> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js')
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')

    const connection = new Connection(getRpcUrl(), 'confirmed')
    const sdk = new CpAmm(connection)

    const poolState = await sdk.fetchPoolState(new PublicKey(poolAddress))
    if (!poolState) return null

    const price = await getDammSolPriceFromPoolState(connection, poolState)
    if (!price) return null

    return { ...price, currentPriceSol: price.solPerToken }
  } catch (err) {
    console.error(`[PRE-GRAD] fetchDammPositionState failed: ${summarizeError(err)}`)
    return null
  }
}

// ── Single-pass monitor ───────────────────────────────────────────────────────

/**
 * checkDammPositions — one evaluation pass over all active DAMM positions.
 *
 * Called directly from the tick route on every cron invocation.
 */
export async function checkDammPositions(livePositions?: LiveMeteoraPosition[]): Promise<{ checked: number; exited: number }> {
  const supabase = createServerClient()
  const live = (livePositions ?? await fetchLiveMeteoraPositions())
    .filter(position => isManagedDammPosition(position))

  if (live.length === 0) {
    return { checked: 0, exited: 0 }
  }

  const livePubkeys = live
    .map(position => position.position_pubkey)
    .filter(Boolean)

  const { data: cachedRows, error } = await supabase
    .from('lp_positions')
    .select('*')
    .in('position_pubkey', livePubkeys)
    .in('status', OPEN_LP_STATUSES)
    .in('position_type', MANAGED_DAMM_DB_POSITION_TYPES)

  if (error) {
    console.error('[PRE-GRAD] DB metadata query error:', error.message)
    return { checked: 0, exited: 0 }
  }

  const positions = mergeDbAndLiveLpPositions(cachedRows ?? [], live, { liveFetchOk: true })
    .filter(isManagedDammPosition)
    .filter(pos => OPEN_LP_STATUSES.includes(pos.status))
    .filter(pos => pos.id && !String(pos.id).startsWith('meteora-'))

  if (positions.length === 0) {
    console.log(`[PRE-GRAD] ${live.length} live DAMM position(s), none bot-managed`)
    return { checked: 0, exited: 0 }
  }

  console.log(`[PRE-GRAD] Evaluating ${positions.length} bot-managed live DAMM position(s)`)
  let exited = 0

  for (const pos of positions) {
    const ageHours = (Date.now() - new Date(pos.opened_at).getTime()) / (1000 * 60 * 60)
    const solDeposited = Number(pos.sol_deposited ?? 1)

    // All three fetches in parallel — no sequential blocking
    const [onChain, poolStats, meteoraPos] = await Promise.all([
      fetchDammPositionState(pos.pool_address),
      fetchDammPoolStats(pos.pool_address),
      fetchMeteoraPosFields(pos.position_pubkey),
    ])

    const claimableFeesUsd = meteoraPos?.claimableFeesUsd ?? null
    const positionValueUsd = meteoraPos?.positionValueUsd ?? null
    if (!meteoraPos) {
      console.warn(`[PRE-GRAD] Meteora DAMM position fetch miss for ${pos.id} (${pos.position_pubkey}) — TP/SL may fall back to price movement`)
    }
    const pnlPct = resolveDammPnlPct(
      pos,
      meteoraPos?.pnlPct ?? null,
      meteoraPos?.pnlUsd ?? null,
      positionValueUsd,
      meteoraPos?.costBasisUsd ?? null,
    )

    // ── Metadata update: store Meteora-sourced USD fields ────────────────────
    // We always update metadata when we have new data, regardless of exit.
    // pnl_sol and il_pct are intentionally NOT written — Meteora is source of truth.
    if (onChain) {
      await supabase
        .from('lp_positions')
        .update({
          current_price: onChain.currentPriceSol,
          ...(claimableFeesUsd !== null && { claimable_fees_usd: Math.round(claimableFeesUsd * 100) / 100 }),
          ...(positionValueUsd !== null && { position_value_usd: Math.round(positionValueUsd * 100) / 100 }),
          metadata: {
            ...(pos.metadata ?? {}),
            // Live USD fields from Meteora — what the UI should display
            ...(claimableFeesUsd !== null && { claimable_fees_usd: Math.round(claimableFeesUsd * 100) / 100 }),
            ...(positionValueUsd !== null && { position_value_usd: Math.round(positionValueUsd * 100) / 100 }),
            current_price_basis: 'sol_per_token',
            raw_pool_price: onChain.poolPrice,
            token_a_mint: onChain.tokenAMint,
            token_b_mint: onChain.tokenBMint,
            token_a_decimals: onChain.tokenADecimals,
            token_b_decimals: onChain.tokenBDecimals,
            // Pool-level context
            ...(poolStats && {
              volume_24h_usd:   Math.round(poolStats.volume24hUsd),
              tvl_usd:          Math.round(poolStats.tvlUsd),
              stats_updated_at: new Date().toISOString(),
            }),
          },
        })
        .eq('id', pos.id)
    } else {
      console.warn(`[PRE-GRAD] RPC miss for ${pos.id} — skipping TP/SL this tick`)
    }

    // ── Exit triggers — price-based signals use normalized SOL/token price ───
    // We use the on-chain price for signal precision (not USD display).
    let reason = ''
    if (ageHours > 72) {
      reason = 'max-duration'
    } else if (onChain) {
      const entryPrice = getDammExitEntryPriceSol(pos, onChain)
      if (!entryPrice) {
        console.warn(`[PRE-GRAD] ${pos.id} has no comparable DAMM entry price — skipping TP/SL this tick`)
      } else {
        const pricePct = ((onChain.currentPriceSol - entryPrice.value) / entryPrice.value) * 100
        if (pnlPct !== null) {
          if (pnlPct <= -30) reason = 'stop-loss'
          else if (pnlPct >= 40) reason = 'take-profit'
        } else {
          if (pricePct <= -30) reason = 'stop-loss'
          else if (pricePct >= 40) reason = 'take-profit'
        }
      }
    }

    if (reason) {
      const label = pos.symbol ?? pos.mint ?? pos.id
      const feesDisplay = claimableFeesUsd !== null ? `$${claimableFeesUsd.toFixed(2)}` : 'n/a'
      const valueDisplay = positionValueUsd !== null ? `$${positionValueUsd.toFixed(2)}` : 'n/a'
      console.log(`[PRE-GRAD] EXIT: ${label} → ${reason} (value=${valueDisplay} claimable=${feesDisplay})`)
      const closed = await handleDammExit(pos.id, reason, pos.symbol ?? pos.mint ?? 'UNKNOWN', pos.opened_at, claimableFeesUsd, positionValueUsd)
      if (closed) exited++
    }
  }

  return { checked: positions.length, exited }
}

/**
 * startPreGradMonitor — kept for backwards compatibility.
 * No-op shim; monitor is driven by checkDammPositions() in the tick route.
 */
export async function startPreGradMonitor(): Promise<void> {}

// ── Exit handler ──────────────────────────────────────────────────────────────

export async function handleDammExit(
  positionId: string,
  reason: string,
  symbol: string = 'UNKNOWN',
  openedAt?: string,
  claimableFeesUsd?: number | null,
  positionValueUsd?: number | null,
): Promise<boolean> {
  const ageMin = openedAt
    ? Math.round((Date.now() - new Date(openedAt).getTime()) / 60_000)
    : 0

  // closeDammPosition writes status='closed' to DB and returns the authoritative
  // post-zap USD values from the Meteora PnL API (4× retry). Use those values in
  // the alert; fall back to the pre-close snapshot only if the API returned null.
  const closeResult = await closeDammPosition(positionId, reason)
  if (closeResult.skipped) {
    console.warn(`[PRE-GRAD] close skipped for ${positionId}: ${closeResult.error ?? 'not closeable'}`)
    return false
  }
  if (!closeResult.success) {
    const message = closeResult.error ?? 'unknown close error'
    console.error(`[PRE-GRAD] closeDammPosition failed for ${positionId}: ${message}`)
    await sendAlert({
      type: 'error',
      message: `DAMM close failed for ${symbol} (${reason})\nPosition: \`${positionId}\`\nError: ${message}`,
    })
    return false
  }

  const alertClaimableFeesUsd = closeResult.totalFeeEarnedUsd ?? claimableFeesUsd ?? undefined
  const alertPositionValueUsd = positionValueUsd ?? undefined
  const alertRealizedPnlUsd   = closeResult.realizedPnlUsd ?? undefined

  await sendAlert({
    type: 'pre_grad_closed',
    symbol,
    positionId,
    reason,
    ageMin,
    ...(alertClaimableFeesUsd != null && { claimableFeesUsd: alertClaimableFeesUsd }),
    ...(alertPositionValueUsd != null && { positionValueUsd: alertPositionValueUsd }),
    ...(alertRealizedPnlUsd   != null && { realizedPnlUsd:   alertRealizedPnlUsd   }),
  })

  console.log(`[PRE-GRAD] Exit closed ${positionId} reason: ${reason}`)
  return true
}

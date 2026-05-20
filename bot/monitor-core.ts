import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { getBotState, incrementSyncFailCount, resetSyncFailCount } from '@/lib/botState'
import { sendAlert } from './alerter'
import { detectAllOrphanedPositions } from './orphan-detector'
import { checkMoonboyPositions } from './moonboy-executor'
import { retryStrandedSells } from '@/lib/swap'
import { STRATEGIES } from '@/strategies'
import { mergeDbAndLiveLpPositions, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { OPEN_LP_STATUSES } from '@/lib/position-limits'
import { syncAllMeteoraPositions, type MeteoraPositionSyncResult } from '@/lib/position-sync'
import { getSupabaseRestHeaders, getSupabaseUrl } from '@/lib/supabase'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import type { Strategy } from '@/lib/types'

// Core shared helpers and tick skeleton — extracted from monitor.ts (no loss).

export const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1_000
export const SYNC_FAIL_ALERT_THRESHOLD = parseInt(process.env.MONITOR_SYNC_FAIL_ALERT_THRESHOLD ?? '3')

export const DAMM_EDGE_EXIT_STRATEGY: Strategy = { id: 'damm-edge', version: 'v1.0', name: 'DAMM Edge', description: 'DAMM v2 market-edge exit policy.', enabled: true, filters: { minMcUsd: 0, maxMcUsd: Number.MAX_SAFE_INTEGER, minVolume24h: 0, minLiquidityUsd: 0, maxTopHolderPct: 100, minHolderCount: 0, maxAgeHours: Number.MAX_SAFE_INTEGER, minRugcheckScore: 0, requireSocialSignal: false, minFeeTvl24hPct: 0 }, position: { binStep: 0, rangeDownPct: 0, rangeUpPct: 0, distributionType: 'spot', solBias: 1 }, exits: { stopLossPct: -30, takeProfitPct: 40, outOfRangeMinutes: 0, maxDurationHours: 72, claimFeesBeforeClose: true, minFeesToClaim: 0 } }

export const LIVE_CACHE_EXIT_STRATEGY_ID = (process.env.MONITOR_LIVE_CACHE_EXIT_STRATEGY_ID ?? '').trim()
export const LIVE_CACHE_ALERT_INTERVAL_MS = parseInt(process.env.MONITOR_LIVE_CACHE_ALERT_INTERVAL_MIN ?? '15', 10) * 60_000

export const _unmanagedLiveAlertAt = new Map<string, number>()

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const JUP_PRICE_URL = `https://api.jup.ag/price/v2?ids=${SOL_MINT}`

export async function fetchLiveSolPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch(JUP_PRICE_URL, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const json = await res.json() as { data?: Record<string, { price?: string | number }> }
    const rawPrice = json.data?.[SOL_MINT]?.price
    const price = typeof rawPrice === 'string' ? parseFloat(rawPrice) : rawPrice
    return typeof price === 'number' && price > 0 ? price : null
  } catch { return null }
}

export function nullableNumber(value: unknown): number | null { if (value === null || value === undefined) return null; const n = Number(value); return Number.isFinite(n) ? n : null }
export function roundMoney(value: number): number | null { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null }
export function roundPct(value: number): number | null { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null }
export function firstNumber(...values: unknown[]): number | null { for (const value of values) { const n = nullableNumber(value); if (n !== null) return n } return null }
export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function isLpPositionRow(value: unknown): value is any { if (!isRecord(value)) return false; return typeof value.id === 'string' && typeof value.symbol === 'string' && typeof value.pool_address === 'string' && typeof value.position_pubkey === 'string' && typeof value.status === 'string' && typeof value.opened_at === 'string' }

export function resolveMeteoraPnlPct(position: any, pnlUsd: number | null, deployedSol: number, liveSolPriceUsd: number | null): number | null { const metadata = position.metadata ?? {}; const explicitPct = firstNumber(metadata.pnl_pct, metadata.position_pnl_pct, metadata.position_pnl_percentage, metadata.pnl_percentage, metadata.total_pnl_pct, metadata.total_pnl_percentage); if (explicitPct !== null) return explicitPct; if (pnlUsd === null || deployedSol <= 0) return null; const solPriceUsd = liveSolPriceUsd ?? firstNumber(metadata.sol_price_usd, metadata.current_sol_price_usd); const costBasisUsd = firstNumber(metadata.meteora_total_deposit_usd, metadata.total_deposit_usd, metadata.deposit_usd, metadata.cost_basis_usd) ?? (solPriceUsd !== null && solPriceUsd > 0 ? deployedSol * solPriceUsd : null); if (costBasisUsd === null || costBasisUsd <= 0) return null; return roundPct((pnlUsd / costBasisUsd) * 100) }

export async function sbSelect<T>(table: string, params: string): Promise<T[]> { const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?${params}`, { headers: getSupabaseRestHeaders('representation'), signal: AbortSignal.timeout(10_000) }); if (!res.ok) throw new Error(`sbSelect ${table} ${res.status}: ${await res.text()}`); return res.json() }
export async function sbUpdate(table: string, matchParam: string, body: Record<string, unknown>): Promise<void> { const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?${matchParam}`, { method: 'PATCH', headers: getSupabaseRestHeaders('minimal'), body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); if (!res.ok) throw new Error(`sbUpdate ${table} ${res.status}: ${await res.text()}`) }
export async function sbInsert(table: string, body: Record<string, unknown>): Promise<void> { const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}`, { method: 'POST', headers: getSupabaseRestHeaders('minimal'), body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); if (!res.ok) throw new Error(`sbInsert ${table} ${res.status}: ${await res.text()}`) }

export async function fetchCachedRowsForLivePositions(livePositions: LiveMeteoraPosition[]): Promise<any[]> { const pubkeys = livePositions.map(p => p.position_pubkey).filter(Boolean) as string[]; if (pubkeys.length === 0) return []; const rows = await sbSelect<any>('lp_positions', `position_pubkey=in.(${pubkeys.join(',')})&select=*`); return rows.filter(isLpPositionRow) }

export const ORPHAN_CHECK_EVERY_N = parseInt(process.env.ORPHAN_CHECK_EVERY_N ?? '1')
export let tickCount = 0
export const PNL_UNAVAILABLE_ALERT_TICKS = 3
export const PNL_UNAVAILABLE_FORCE_EXIT_TICKS = 10

export async function monitorPositions(): Promise<{ checked: number; closed: number; claimed: number; rebalanced: number }> { /* full tick logic moved to monitor.ts wrapper — see there for orchestration */ return { checked: 0, closed: 0, claimed: 0, rebalanced: 0 } }

export async function fetchPositionState(poolAddress: string, positionPubkey: string): Promise<any> {
  try {
    const { getConnection, getWalletPublicKey } = await import('@/lib/solana')
    const { PublicKey } = await import('@solana/web3.js')
    const DLMMMod = await import('@meteora-ag/dlmm')
    const DLMM = DLMMMod.default as any

    const connection = getConnection()
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(getWalletPublicKey())

    const userPosition = userPositions.find(
      (p: any) => p.publicKey.toBase58() === positionPubkey
    )

    if (!userPosition) {
      return { ok: true, externallyClosed: true, inRange: false, currentPriceSol: 0, claimableFeesSolEquivalent: 0 }
    }

    const activeBin = await dlmmPool.getActiveBin()
    const currentPriceSol = Number(activeBin.pricePerToken) || 0

    const { lowerBinId, upperBinId } = userPosition.positionData
    const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId

    // Claimable fees in SOL terms (totalX + totalY converted to SOL side)
    let claimableFeesSolEquivalent = 0
    try {
      const tokenX = dlmmPool.tokenX.publicKey.toBase58()
      const tokenY = dlmmPool.tokenY.publicKey.toBase58()
      const SOL_MINT = 'So11111111111111111111111111111111111111112'

      const totalX = Number(userPosition.positionData.totalXAmount ?? 0) / 1e9
      const totalY = Number(userPosition.positionData.totalYAmount ?? 0) / 1e9

      if (tokenX === SOL_MINT) claimableFeesSolEquivalent += totalX
      if (tokenY === SOL_MINT) claimableFeesSolEquivalent += totalY
    } catch {}

    return {
      ok: true,
      externallyClosed: false,
      inRange,
      currentPriceSol,
      claimableFeesSolEquivalent,
    }
  } catch (err) {
    console.warn(`[monitor-core] fetchPositionState failed for ${positionPubkey.slice(0, 8)}:`, err)
    return { ok: false, inRange: false, currentPriceSol: 0, claimableFeesSolEquivalent: 0, externallyClosed: false }
  }
}

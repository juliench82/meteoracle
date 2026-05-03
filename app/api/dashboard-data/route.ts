import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { fetchLiveMeteoraSnapshot, mergeDbAndLiveLpPositions, type MeteoraLiveSourceStatus } from '@/lib/meteora-live'
import { fetchWalletLiveBalances } from '@/lib/wallet-live'

export const dynamic = 'force-dynamic'

function dashboardJson(body: Record<string, unknown>) {
  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  })
}

function n(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function average(values: number[]): number | null {
  const valid = values.filter(value => Number.isFinite(value))
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function liveSourceLabel(source: MeteoraLiveSourceStatus): 'meteora-live' | 'meteora-live-partial' | 'supabase-cache' {
  if (source.dlmmOk && source.dammOk) return 'meteora-live'
  if (source.dlmmOk || source.dammOk) return 'meteora-live-partial'
  return 'supabase-cache'
}

function isDammLp(position: { strategy_id?: string | null; position_type?: string | null }): boolean {
  return (
    position.strategy_id === 'damm-edge' ||
    position.strategy_id === 'damm-live' ||
    position.strategy_id === 'damm-migration' ||
    position.strategy_id === 'damm-launch' ||
    position.position_type === 'damm-edge' ||
    position.position_type === 'damm-migration' ||
    position.position_type === 'damm-launch'
  )
}

function buildPortfolioSummary(openLp: any[], closedLp: any[], liveSource: MeteoraLiveSourceStatus) {
  const totalPositionValueUsd = openLp.reduce(
    (sum, position) => sum + n(position.position_value_usd ?? position.metadata?.position_value_usd),
    0,
  )
  const totalClaimableFeesUsd = openLp.reduce(
    (sum, position) => sum + n(position.claimable_fees_usd ?? position.metadata?.claimable_fees_usd),
    0,
  )
  const totalFeesClaimedUsd = openLp.reduce(
    (sum, position) => sum +
      n(position.metadata?.total_fee_usd_claimed) +
      n(position.metadata?.total_reward_usd_claimed) +
      n(position.metadata?.fees_claimed_usd),
    0,
  )
  const totalFeesEarnedUsd = openLp.reduce(
    (sum, position) => sum + n(position.metadata?.total_fee_earned_usd),
    0,
  )
  const avgFeeApr24h = average(openLp.map(position => n(position.metadata?.fee_apr_24h)).filter(Boolean))
  const realizedRows = closedLp
    .map(position => n(position.realized_pnl_usd ?? position.metadata?.realized_pnl_usd))
    .filter(value => value !== 0)
  const wins = realizedRows.filter(value => value > 0)

  return {
    source: liveSourceLabel(liveSource),
    openCount: openLp.length,
    dlmmCount: openLp.filter(position => position.position_type === 'dlmm').length,
    dammCount: openLp.filter(isDammLp).length,
    outOfRangeCount: openLp.filter(position => position.status === 'out_of_range').length,
    totalPositionValueUsd: Math.round(totalPositionValueUsd * 100) / 100,
    totalClaimableFeesUsd: Math.round(totalClaimableFeesUsd * 100) / 100,
    totalFeesClaimedUsd: Math.round(totalFeesClaimedUsd * 100) / 100,
    totalFeesEarnedUsd: Math.round(totalFeesEarnedUsd * 100) / 100,
    averagePositionValueUsd: openLp.length ? Math.round((totalPositionValueUsd / openLp.length) * 100) / 100 : null,
    averageFeeApr24h: avgFeeApr24h !== null ? Math.round(avgFeeApr24h * 100) / 100 : null,
    cachedHistory: {
      source: 'supabase-cache',
      closedCount: closedLp.length,
      realizedPnlUsd: Math.round(realizedRows.reduce((sum, value) => sum + value, 0) * 100) / 100,
      winRatePct: realizedRows.length ? Math.round((wins.length / realizedRows.length) * 10_000) / 100 : null,
      biggestWinUsd: realizedRows.length ? Math.round(Math.max(...realizedRows) * 100) / 100 : null,
    },
  }
}

export async function GET() {
  const supabase = createServerClient()

  const [openSpotRes, closedSpotRes, openLpRes, closedLpRes, watchlistRes] = await Promise.allSettled([
    supabase.from('spot_positions').select('*').eq('status', 'open').order('opened_at', { ascending: false }),
    supabase.from('spot_positions').select('*').in('status', ['closed_tp', 'closed_sl', 'closed_manual', 'closed_timeout']).order('closed_at', { ascending: false }).limit(50),
    supabase.from('lp_positions').select('*').in('status', ['active', 'open', 'out_of_range', 'pending_retry', 'orphaned']).order('opened_at', { ascending: false }),
    supabase.from('lp_positions').select('*').eq('status', 'closed').order('closed_at', { ascending: false }).limit(50),
    supabase.from('pre_grad_watchlist').select('*').order('detected_at', { ascending: false }).limit(20),
  ])

  const dbOpenLp = openLpRes.status === 'fulfilled' ? (openLpRes.value.data ?? []) : []
  let liveLp: Awaited<ReturnType<typeof fetchLiveMeteoraSnapshot>>['positions'] = []
  let liveSource: MeteoraLiveSourceStatus = { dlmmOk: false, dammOk: false }
  let liveErrors: { dlmm?: string | null; damm?: string | null } = {}
  try {
    const snapshot = await fetchLiveMeteoraSnapshot()
    liveLp = snapshot.positions
    liveSource = { dlmmOk: snapshot.dlmmOk, dammOk: snapshot.dammOk }
    liveErrors = { dlmm: snapshot.dlmmError, damm: snapshot.dammError }
    if (!snapshot.dlmmOk || !snapshot.dammOk) {
      console.warn('[dashboard-data] partial Meteora live fetch failure:', liveErrors)
    }
  } catch (err) {
    console.warn('[dashboard-data] Meteora live position fetch failed; using Supabase cache:', err)
  }
  const wallet = await fetchWalletLiveBalances(liveLp.map(p => p.mint)).catch((err) => {
    console.warn('[dashboard-data] wallet balance fetch failed:', err)
    return null
  })
  const openLp = mergeDbAndLiveLpPositions(dbOpenLp, liveLp, liveSource)
  const closedLp = closedLpRes.status === 'fulfilled' ? (closedLpRes.value.data ?? []) : []

  return dashboardJson({
    openSpot:   openSpotRes.status   === 'fulfilled' ? (openSpotRes.value.data   ?? []) : [],
    closedSpot: closedSpotRes.status === 'fulfilled' ? (closedSpotRes.value.data ?? []) : [],
    openLp,
    closedLp,
    watchlist:  watchlistRes.status  === 'fulfilled' ? (watchlistRes.value.data  ?? []) : [],
    wallet,
    portfolio: buildPortfolioSummary(openLp, closedLp, liveSource),
    meteoraLive: {
      ok: liveSource.dlmmOk || liveSource.dammOk,
      dlmmOk: liveSource.dlmmOk,
      dammOk: liveSource.dammOk,
      errors: liveErrors,
      count: liveLp.length,
      dlmm: liveLp.filter(p => p.position_type === 'dlmm').length,
      damm: liveLp.filter(p => p.position_type === 'damm-edge').length,
    },
  })
}

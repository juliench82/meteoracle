import { unstable_cache } from 'next/cache'
import { createServerClient } from '@/lib/supabase'
import {
  fetchLiveMeteoraSnapshot,
  mergeDbAndLiveLpPositions,
  type MeteoraLiveSourceStatus,
  type LiveMeteoraPosition,
} from '@/lib/meteora-live'
import { fetchWalletLiveBalances } from '@/lib/wallet-live'
import { fetchMoonboyLivePositions } from '@/lib/moonboy-live'

export interface DashboardData {
  openSpot: any[]
  closedSpot: any[]
  openLp: any[]
  closedLp: any[]
  watchlist: any[]
  wallet: any
  portfolio: any
  moonboy: any[]
  meteoraLive: {
    ok: boolean
    dlmmOk: boolean
    dammOk: boolean
    errors: { dlmm?: string | null; damm?: string | null }
    count: number
    dlmm: number
    damm: number
  }
  source: string
}

const DASHBOARD_REVALIDATE_SECONDS = 45

async function fetchDashboardDataUncached(): Promise<DashboardData> {
  const supabase = createServerClient()

  // 1. Fetch live Meteora data first (source of truth for open positions + PnL)
  let liveSnapshot: Awaited<ReturnType<typeof fetchLiveMeteoraSnapshot>> | null = null
  let liveSource: MeteoraLiveSourceStatus = { dlmmOk: false, dammOk: false }
  let liveErrors: { dlmm?: string | null; damm?: string | null } = {}

  try {
    liveSnapshot = await fetchLiveMeteoraSnapshot()
    liveSource = { dlmmOk: liveSnapshot.dlmmOk, dammOk: liveSnapshot.dammOk }
    liveErrors = { dlmm: liveSnapshot.dlmmError, damm: liveSnapshot.dammError }
  } catch (err) {
    console.warn('[dashboard] Live Meteora snapshot failed:', err)
  }

  const liveLp: LiveMeteoraPosition[] = liveSnapshot?.positions ?? []

  // 2. Targeted Supabase enrichment for open positions (only for live pubkeys)
  // This is the key change to dramatically reduce Supabase load
  let dbOpenLp: any[] = []
  const livePubkeys = liveLp.map(p => p.position_pubkey).filter(Boolean)

  if (livePubkeys.length > 0) {
    const { data, error } = await supabase
      .from('lp_positions')
      .select('position_pubkey, strategy_id, opened_at, metadata, dry_run, sol_deposited')
      .in('position_pubkey', livePubkeys)
      .limit(200)

    if (error) {
      console.warn('[dashboard] Targeted open LP enrichment query failed:', error.message)
    } else {
      dbOpenLp = data ?? []
    }
  }

  // 3. Merge — live data wins for PnL, values, fees, price, in_range
  const openLp = mergeDbAndLiveLpPositions(dbOpenLp, liveLp, liveSource)

  // 4. Closed positions (historical — still from Supabase, limited)
  const { data: closedLpData } = await supabase
    .from('lp_positions')
    .select('*')
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(35)

  const closedLp = closedLpData ?? []

  // 5. Other lighter queries
  const [openSpotRes, closedSpotRes, watchlistRes] = await Promise.allSettled([
    supabase.from('spot_positions').select('*').eq('status', 'open').order('opened_at', { ascending: false }),
    supabase.from('spot_positions').select('*').in('status', ['closed_tp', 'closed_sl', 'closed_manual', 'closed_timeout']).order('closed_at', { ascending: false }).limit(35),
    supabase.from('pre_grad_watchlist').select('*').order('detected_at', { ascending: false }).limit(15),
  ])

  const openSpot = openSpotRes.status === 'fulfilled' ? (openSpotRes.value.data ?? []) : []
  const closedSpot = closedSpotRes.status === 'fulfilled' ? (closedSpotRes.value.data ?? []) : []
  const watchlist = watchlistRes.status === 'fulfilled' ? (watchlistRes.value.data ?? []) : []

  // 6. Live supporting data
  const wallet = await fetchWalletLiveBalances(liveLp.map(p => p.mint)).catch(() => null)
  const moonboy = await fetchMoonboyLivePositions().catch(() => [])

  // 7. Portfolio summary using live data where possible
  const portfolio = buildPortfolioSummary(openLp, closedLp, liveSource)

  return {
    openSpot,
    closedSpot,
    openLp,
    closedLp,
    watchlist,
    wallet,
    portfolio,
    moonboy,
    meteoraLive: {
      ok: liveSource.dlmmOk || liveSource.dammOk,
      dlmmOk: liveSource.dlmmOk,
      dammOk: liveSource.dammOk,
      errors: liveErrors,
      count: liveLp.length,
      dlmm: liveLp.filter(p => p.position_type === 'dlmm').length,
      damm: 0, // DAMM v2 removed
    },
    source: liveSource.dlmmOk && liveSource.dammOk ? 'meteora-live' : 'meteora-live-partial',
  }
}

function buildPortfolioSummary(openLp: any[], closedLp: any[], liveSource: MeteoraLiveSourceStatus) {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

  const totalPositionValueUsd = openLp.reduce((sum, p) => sum + n(p.position_value_usd), 0)
  const totalClaimableFeesUsd = openLp.reduce((sum, p) => sum + n(p.claimable_fees_usd), 0)

  const realizedRows = closedLp
    .map(p => n(p.realized_pnl_usd))
    .filter(v => v !== 0)

  const wins = realizedRows.filter(v => v > 0)

  // Maintain backward compatibility with existing frontend components
  const totalFeesClaimedUsd = openLp.reduce((sum, p) => {
    return sum +
      n(p.metadata?.total_fee_usd_claimed) +
      n(p.metadata?.total_reward_usd_claimed) +
      n(p.metadata?.fees_claimed_usd)
  }, 0)

  const avgFeeApr24h = (() => {
    const vals = openLp.map(p => n(p.metadata?.fee_apr_24h)).filter(Boolean)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  })()

  return {
    source: liveSource.dlmmOk || liveSource.dammOk ? 'meteora-live' : 'supabase-cache',
    openCount: openLp.length,
    dlmmCount: openLp.filter(p => p.position_type === 'dlmm').length,
    dammCount: 0, // DAMM v2 removed
    outOfRangeCount: openLp.filter(p => p.status === 'out_of_range').length,
    totalPositionValueUsd: Math.round(totalPositionValueUsd * 100) / 100,
    totalClaimableFeesUsd: Math.round(totalClaimableFeesUsd * 100) / 100,
    totalFeesClaimedUsd: Math.round(totalFeesClaimedUsd * 100) / 100,
    totalFeesEarnedUsd: Math.round(openLp.reduce((sum, p) => sum + n(p.metadata?.total_fee_earned_usd), 0) * 100) / 100,
    averagePositionValueUsd: openLp.length ? Math.round((totalPositionValueUsd / openLp.length) * 100) / 100 : null,
    averageFeeApr24h: avgFeeApr24h !== null ? Math.round(avgFeeApr24h * 100) / 100 : null,
    realizedPnlUsd: Math.round(realizedRows.reduce((s, v) => s + v, 0) * 100) / 100,
    winRatePct: realizedRows.length ? Math.round((wins.length / realizedRows.length) * 1000) / 10 : null,
    biggestWinUsd: realizedRows.length ? Math.round(Math.max(...realizedRows) * 100) / 100 : null,
    cachedHistory: {
      source: 'supabase-cache',
      closedCount: closedLp.length,
      realizedPnlUsd: Math.round(realizedRows.reduce((s, v) => s + v, 0) * 100) / 100,
      winRatePct: realizedRows.length ? Math.round((wins.length / realizedRows.length) * 1000) / 10 : null,
      biggestWinUsd: realizedRows.length ? Math.round(Math.max(...realizedRows) * 100) / 100 : null,
    },
  }
}

// Cached version — 45s revalidate is acceptable per user (60s freshness tolerance)
export const getDashboardData = unstable_cache(
  fetchDashboardDataUncached,
  ['dashboard-data'],
  { revalidate: 45, tags: ['dashboard'] }
)
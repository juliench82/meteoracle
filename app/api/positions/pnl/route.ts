import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { redis } from '@/lib/redis'
import { fetchLiveMeteoraSnapshot, mergeDbAndLiveLpPositions } from '@/lib/meteora-live'

export const runtime = 'nodejs'
export const maxDuration = 30
export const dynamic = 'force-dynamic'

const CACHE_TTL = 20
const RATE_LIMIT_WINDOW = 60
const RATE_LIMIT_MAX = 30

export async function GET() {
  const ip = 'global'
  const rlKey = `rl:pnl:${ip}`
  const calls = await redis.get<number>(rlKey)
  if (calls && calls >= RATE_LIMIT_MAX) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }
  await redis.set(rlKey, (calls ?? 0) + 1, RATE_LIMIT_WINDOW)

  const cached = await redis.get<object>('pnl:snapshot')
  if (cached) return NextResponse.json(cached)

  let livePositions: Awaited<ReturnType<typeof fetchLiveMeteoraSnapshot>>['positions'] = []
  let liveSource = { dlmmOk: false, dammOk: false }
  try {
    const snapshot = await fetchLiveMeteoraSnapshot()
    livePositions = snapshot.positions
    liveSource = { dlmmOk: snapshot.dlmmOk, dammOk: snapshot.dammOk }
    if (!snapshot.dlmmOk || !snapshot.dammOk) {
      console.warn('[positions/pnl] partial Meteora live fetch failure:', {
        dlmm: snapshot.dlmmError,
        damm: snapshot.dammError,
      })
    }
  } catch (err) {
    console.warn('[positions/pnl] live Meteora fetch failed:', err)
  }

  if (!livePositions.length) {
    return NextResponse.json({
      positions: [],
      totalClaimableFeesUsd: 0,
      totalPositionValueUsd: 0,
      liveSource: liveSource.dlmmOk || liveSource.dammOk ? 'meteora' : 'meteora-unavailable',
      meteoraLive: {
        ok: liveSource.dlmmOk || liveSource.dammOk,
        dlmmOk: liveSource.dlmmOk,
        dammOk: liveSource.dammOk,
      },
      cachedAt: new Date().toISOString(),
    })
  }

  const supabase = createServerClient()
  const livePubkeys = livePositions
    .map(position => position.position_pubkey)
    .filter(Boolean)

  const { data: cachedRows, error } = await supabase
    .from('lp_positions')
    .select('*')
    .in('position_pubkey', livePubkeys)

  if (error) {
    console.warn('[positions/pnl] DB metadata query failed, using live rows only:', error.message)
  }

  const positions = mergeDbAndLiveLpPositions(cachedRows ?? [], livePositions, liveSource)

  const enriched = positions.map((pos) => {
    const currentPriceSol = Number(pos.current_price ?? 0)
    const claimableFeesUsd = Number(pos.claimable_fees_usd ?? pos.metadata?.claimable_fees_usd ?? 0)
    const positionValueUsd = Number(pos.position_value_usd ?? pos.metadata?.position_value_usd ?? 0)
    const entryPriceSol: number = Number(
      pos.entry_price_sol ??
      pos.metadata?.entry_price_sol ??
      pos.metadata?.entryPriceSol ??
      0,
    )

    const pricePct = entryPriceSol > 0 && currentPriceSol > 0
      ? ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100
      : 0

    const k = entryPriceSol > 0 && currentPriceSol > 0
      ? currentPriceSol / entryPriceSol
      : 1
    const ilPct = entryPriceSol > 0 && currentPriceSol > 0
      ? (2 * Math.sqrt(k) / (1 + k) - 1) * 100
      : 0

    return {
      id: pos.id,
      symbol: pos.symbol,
      strategy: pos.strategy_id,
      positionType: pos.position_type,
      currentPrice: currentPriceSol,
      pricePct: Math.round(pricePct * 100) / 100,
      claimableFeesUsd: Math.round(claimableFeesUsd * 100) / 100,
      positionValueUsd: Math.round(positionValueUsd * 100) / 100,
      ilPct: Math.round(ilPct * 100) / 100,
      realizedPnlUsd: pos.realized_pnl_usd ?? pos.metadata?.realized_pnl_usd ?? null,
      status: pos.status,
      source: pos._source ?? 'meteora-live',
    }
  })

  const totalClaimableFeesUsd = enriched.reduce((a, p) => a + p.claimableFeesUsd, 0)
  const totalPositionValueUsd = enriched.reduce((a, p) => a + p.positionValueUsd, 0)

  const snapshot = {
    positions: enriched,
    totalClaimableFeesUsd: Math.round(totalClaimableFeesUsd * 100) / 100,
    totalPositionValueUsd: Math.round(totalPositionValueUsd * 100) / 100,
    liveSource: 'meteora',
    cachedAt: new Date().toISOString(),
  }

  await redis.set('pnl:snapshot', snapshot, CACHE_TTL)
  return NextResponse.json(snapshot)
}

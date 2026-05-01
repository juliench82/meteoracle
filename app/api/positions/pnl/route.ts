import { NextResponse } from 'next/server'
import { PublicKey } from '@solana/web3.js'
import { getConnection } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { redis } from '@/lib/redis'

export const runtime = 'nodejs'
export const maxDuration = 30
export const dynamic = 'force-dynamic'

const CACHE_TTL = 20
const RATE_LIMIT_WINDOW = 60
const RATE_LIMIT_MAX = 30

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

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

  const supabase = createServerClient()
  const { data: positions, error } = await supabase
    .from('lp_positions')
    .select('*')
    .in('status', ['active', 'out_of_range'])

  if (error || !positions?.length) {
    return NextResponse.json({ positions: [], totalClaimableFeesUsd: 0, totalPositionValueUsd: 0 })
  }

  const connection = getConnection()
  const DLMM = await getDLMM()

  const enriched = await Promise.all(
    positions.map(async (pos) => {
      try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(pos.pool_address))
        const activeBin = await dlmmPool.getActiveBin()
        const currentPriceSol = parseFloat(activeBin.pricePerToken)

        const claimableFeesUsd = Number(pos.claimable_fees_usd ?? pos.metadata?.claimable_fees_usd ?? 0)
        const positionValueUsd = Number(pos.position_value_usd ?? pos.metadata?.position_value_usd ?? 0)

        const entryPriceSol: number = pos.metadata?.entryPriceSol ?? 0
        const pricePct = entryPriceSol > 0
          ? ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100
          : 0

        const k = entryPriceSol > 0 && currentPriceSol > 0
          ? currentPriceSol / entryPriceSol
          : 1
        const ilPct = entryPriceSol > 0
          ? (2 * Math.sqrt(k) / (1 + k) - 1) * 100
          : 0

        return {
          id: pos.id,
          symbol: pos.symbol,
          strategy: pos.strategy_id,
          currentPrice: currentPriceSol,
          pricePct: Math.round(pricePct * 100) / 100,
          claimableFeesUsd: Math.round(claimableFeesUsd * 100) / 100,
          positionValueUsd: Math.round(positionValueUsd * 100) / 100,
          ilPct: Math.round(ilPct * 100) / 100,
          realizedPnlUsd: pos.realized_pnl_usd ?? pos.metadata?.realized_pnl_usd ?? null,
          status: pos.status,
        }
      } catch {
        const claimableFeesUsd = Number(pos.claimable_fees_usd ?? pos.metadata?.claimable_fees_usd ?? 0)
        const positionValueUsd = Number(pos.position_value_usd ?? pos.metadata?.position_value_usd ?? 0)
        return {
          id: pos.id,
          symbol: pos.symbol,
          strategy: pos.strategy_id,
          currentPrice: pos.current_price ?? 0,
          pricePct: 0,
          claimableFeesUsd: Math.round(claimableFeesUsd * 100) / 100,
          positionValueUsd: Math.round(positionValueUsd * 100) / 100,
          ilPct: pos.il_pct ?? 0,
          realizedPnlUsd: pos.realized_pnl_usd ?? pos.metadata?.realized_pnl_usd ?? null,
          status: pos.status,
        }
      }
    })
  )

  const totalClaimableFeesUsd = enriched.reduce((a, p) => a + p.claimableFeesUsd, 0)
  const totalPositionValueUsd = enriched.reduce((a, p) => a + p.positionValueUsd, 0)

  const snapshot = {
    positions: enriched,
    totalClaimableFeesUsd: Math.round(totalClaimableFeesUsd * 100) / 100,
    totalPositionValueUsd: Math.round(totalPositionValueUsd * 100) / 100,
    cachedAt: new Date().toISOString(),
  }

  await redis.set('pnl:snapshot', snapshot, CACHE_TTL)
  return NextResponse.json(snapshot)
}

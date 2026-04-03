import { NextResponse } from 'next/server'
import DLMM from '@meteora-ag/dlmm'
import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { redis } from '@/lib/redis'

export const runtime = 'nodejs'
export const maxDuration = 30
export const dynamic = 'force-dynamic'

const CACHE_TTL = 20 // seconds
const RATE_LIMIT_WINDOW = 60
const RATE_LIMIT_MAX = 30

export async function GET() {
  // Rate limiting via Vercel KV
  const ip = 'global' // cron-based, single caller
  const rlKey = `rl:pnl:${ip}`
  const calls = await redis.get<number>(rlKey)
  if (calls && calls >= RATE_LIMIT_MAX) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }
  await redis.set(rlKey, (calls ?? 0) + 1, RATE_LIMIT_WINDOW)

  // Serve from cache if fresh
  const cached = await redis.get<object>('pnl:snapshot')
  if (cached) return NextResponse.json(cached)

  const supabase = createServerClient()
  const { data: positions, error } = await supabase
    .from('positions')
    .select('*')
    .in('status', ['active', 'out_of_range'])

  if (error || !positions?.length) {
    return NextResponse.json({ positions: [], totalPnlSol: 0, totalFeesSol: 0 })
  }

  const connection = getConnection()
  const wallet = getWallet()

  const enriched = await Promise.all(
    positions.map(async (pos) => {
      try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(pos.pool_address))
        const activeBin = await dlmmPool.getActiveBin()
        const currentPrice = parseFloat(activeBin.pricePerToken)

        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
        const match = userPositions.find(
          (p) => p.publicKey.toBase58() === pos.metadata?.positionPubKey
        )

        const feesSol = match ? match.positionData.feeY.toNumber() / 1e9 : (pos.fees_earned_sol ?? 0)
        const entryPrice = pos.entry_price ?? 0
        const pricePct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0

        // Impermanent loss approximation: IL% ≈ 2√k/(1+k) - 1, k = currentPrice/entryPrice
        const k = entryPrice > 0 ? currentPrice / entryPrice : 1
        const ilPct = entryPrice > 0 ? (2 * Math.sqrt(k) / (1 + k) - 1) * 100 : 0

        const pnlSol = pos.sol_deposited * (pricePct / 100) + feesSol

        return {
          id: pos.id,
          symbol: pos.token_symbol,
          strategy: pos.strategy_id,
          currentPrice,
          pricePct: Math.round(pricePct * 100) / 100,
          feesSol: Math.round(feesSol * 1e6) / 1e6,
          ilPct: Math.round(ilPct * 100) / 100,
          pnlSol: Math.round(pnlSol * 1e6) / 1e6,
          status: pos.status,
        }
      } catch {
        return {
          id: pos.id,
          symbol: pos.token_symbol,
          strategy: pos.strategy_id,
          currentPrice: pos.current_price ?? 0,
          pricePct: 0,
          feesSol: pos.fees_earned_sol ?? 0,
          ilPct: 0,
          pnlSol: pos.pnl_sol ?? 0,
          status: pos.status,
        }
      }
    })
  )

  const totalPnlSol = enriched.reduce((a, p) => a + p.pnlSol, 0)
  const totalFeesSol = enriched.reduce((a, p) => a + p.feesSol, 0)

  const snapshot = {
    positions: enriched,
    totalPnlSol: Math.round(totalPnlSol * 1e6) / 1e6,
    totalFeesSol: Math.round(totalFeesSol * 1e6) / 1e6,
    cachedAt: new Date().toISOString(),
  }

  await redis.set('pnl:snapshot', snapshot, CACHE_TTL)
  return NextResponse.json(snapshot)
}

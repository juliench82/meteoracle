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
        // pricePerToken is SOL-per-token — same unit as metadata.entryPriceSol
        const currentPriceSol = parseFloat(activeBin.pricePerToken)

        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
        const match = userPositions.find(
          (p) => p.publicKey.toBase58() === pos.metadata?.positionPubKey
        )

        const feesSol = match
          ? match.positionData.feeY.toNumber() / 1e9
          : (pos.fees_earned_sol ?? 0)

        // Use entryPriceSol from metadata (SOL-denominated) — same as monitor.ts
        // Fall back to pnl_sol already persisted in DB if no reliable entry price
        const entryPriceSol: number = pos.metadata?.entryPriceSol ?? 0
        const pricePct = entryPriceSol > 0
          ? ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100
          : 0

        // Impermanent loss: IL% ≈ 2√k/(1+k) - 1
        const k = entryPriceSol > 0 && currentPriceSol > 0
          ? currentPriceSol / entryPriceSol
          : 1
        const ilPct = entryPriceSol > 0
          ? (2 * Math.sqrt(k) / (1 + k) - 1) * 100
          : 0

        // pnlSol: price appreciation on deployed capital + fees earned
        const pnlSol = entryPriceSol > 0
          ? pos.sol_deposited * (pricePct / 100) + feesSol
          : (pos.pnl_sol ?? feesSol) // fallback to persisted value

        return {
          id: pos.id,
          symbol: pos.token_symbol,
          strategy: pos.strategy_id,
          currentPrice: currentPriceSol,
          pricePct: Math.round(pricePct * 100) / 100,
          feesSol: Math.round(feesSol * 1e6) / 1e6,
          ilPct: Math.round(ilPct * 100) / 100,
          pnlSol: Math.round(pnlSol * 1e6) / 1e6,
          status: pos.status,
        }
      } catch {
        // On RPC error fall back to DB-persisted values
        return {
          id: pos.id,
          symbol: pos.token_symbol,
          strategy: pos.strategy_id,
          currentPrice: pos.current_price ?? 0,
          pricePct: 0,
          feesSol: pos.fees_earned_sol ?? 0,
          ilPct: pos.il_pct ?? 0,
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

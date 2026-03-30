import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getStrategyForToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import type { TokenMetrics } from '@/lib/types'

// ---------------------------------------------------------------------------
// DexScreener — Meteora DLMM pairs via token search on WSOL
// This bypasses the dlmm-api.meteora.ag endpoint which blocks Vercel IPs.
// We query DexScreener for all pairs on Meteora that include WSOL, then
// use the liquidity/volume data already present in the response.
// ---------------------------------------------------------------------------
const WSOL = 'So11111111111111111111111111111111111111112'
const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/tokens/'
const DEXSCREENER_PAIRS  = 'https://api.dexscreener.com/latest/dex/pairs/solana/'

const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 50_000_000,
  maxAgeHours: 72,
}

const MIN_SCORE_TO_OPEN       = parseInt(process.env.MIN_SCORE_TO_OPEN       ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

// DexScreener pair shape (subset we use)
interface DexPair {
  pairAddress: string
  baseToken:   { address: string; symbol: string }
  quoteToken:  { address: string; symbol: string }
  priceUsd?:   string
  liquidity?:  { usd?: number }
  volume?:     { h24?: number }
  pairCreatedAt?: number
  marketCap?:  number
  fdv?:        number
  dexId:       string
}

export async function runScanner(): Promise<{
  scanned: number
  candidates: number
  opened: number
  error?: string
}> {
  console.log('[scanner] tick started')

  const supabase = createServerClient()

  const { count: openCount } = await supabase
    .from('positions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['active', 'out_of_range'])

  if ((openCount ?? 0) >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[scanner] max positions reached (${openCount}/${MAX_CONCURRENT_POSITIONS})`)
    return { scanned: 0, candidates: 0, opened: 0 }
  }

  // 1. Pull all Meteora DLMM pairs that contain WSOL from DexScreener
  const { pairs, error: fetchError } = await fetchMeteoraPairs()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return { scanned: 0, candidates: 0, opened: 0, error: fetchError }
  }
  console.log(`[scanner] fetched ${pairs.length} Meteora/WSOL pairs from DexScreener`)

  // 2. Pre-filter by liquidity / volume / age
  const preFiltered = pairs.filter(applyPreFilter)
  console.log(`[scanner] ${preFiltered.length} passed pre-filter`)

  let candidateCount = 0
  let openedCount    = 0

  for (const pair of preFiltered) {
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    try {
      // The "token" is whichever side is NOT WSOL
      const tokenAddress = pair.baseToken.address === WSOL
        ? pair.quoteToken.address
        : pair.baseToken.address
      const symbol = pair.baseToken.address === WSOL
        ? pair.quoteToken.symbol
        : pair.baseToken.symbol

      // Skip if scanned recently
      const { data: existing } = await supabase
        .from('candidates')
        .select('id')
        .eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .limit(1)
      if (existing && existing.length > 0) continue

      // Skip if already have open position
      const { data: existingPosition } = await supabase
        .from('positions')
        .select('id')
        .eq('token_address', tokenAddress)
        .in('status', ['active', 'out_of_range'])
        .limit(1)
      if (existingPosition && existingPosition.length > 0) continue

      // Holder data from Helius
      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      // Rugcheck score
      const rugScore = await checkRugscore(tokenAddress)

      const liquidityUsd = pair.liquidity?.usd ?? 0
      const volume24h    = pair.volume?.h24    ?? 0
      const mcUsd        = pair.marketCap      ?? pair.fdv ?? 0
      const priceUsd     = parseFloat(pair.priceUsd ?? '0')
      const ageHours     = pair.pairCreatedAt
        ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60)
        : 999

      const metrics: TokenMetrics = {
        address:       tokenAddress,
        symbol,
        mcUsd,
        volume24h,
        liquidityUsd,
        topHolderPct:  holderData.topHolderPct,
        holderCount:   holderData.holderCount,
        ageHours,
        rugcheckScore: rugScore,
        priceUsd,
        poolAddress:   pair.pairAddress,
        dexId:         'meteora',
      }

      const strategy = getStrategyForToken(metrics)
      if (!strategy) {
        console.log(
          `[scanner] ${symbol} — no strategy matched` +
          ` (mc=$${mcUsd.toFixed(0)}, vol=$${volume24h.toFixed(0)},` +
          ` holders=${holderData.holderCount}, rug=${rugScore}, age=${ageHours.toFixed(1)}h)`
        )
        continue
      }

      const score = scoreCandidate(metrics)

      await supabase.from('candidates').insert({
        token_address:    metrics.address,
        symbol:           metrics.symbol,
        score,
        strategy_matched: strategy.id,
        mc_at_scan:       metrics.mcUsd,
        volume_24h:       metrics.volume24h,
        holder_count:     metrics.holderCount,
        rugcheck_score:   metrics.rugcheckScore,
        top_holder_pct:   metrics.topHolderPct,
        scanned_at:       new Date().toISOString(),
      })

      candidateCount++
      console.log(`[scanner] candidate: ${symbol} → ${strategy.id} (score: ${score})`)

      await sendAlert({
        type:     'candidate_found',
        symbol,
        strategy: strategy.id,
        score,
        mcUsd:    metrics.mcUsd,
        volume24h: metrics.volume24h,
      })

      if (score >= MIN_SCORE_TO_OPEN) {
        const positionId = await openPosition(metrics, strategy)
        if (positionId) {
          openedCount++
          await sendAlert({
            type:          'position_opened',
            symbol,
            strategy:      strategy.id,
            solDeposited:  strategy.position.maxSolPerPosition,
            entryPrice:    metrics.priceUsd,
          })
        }
      }
    } catch (err) {
      console.error(`[scanner] error processing ${pair.pairAddress}:`, err)
    }
  }

  console.log(
    `[scanner] done — scanned: ${preFiltered.length}, candidates: ${candidateCount}, opened: ${openedCount}`
  )
  return { scanned: preFiltered.length, candidates: candidateCount, opened: openedCount }
}

// ---------------------------------------------------------------------------
// Fetch Meteora DLMM pairs via DexScreener token search on WSOL
// DexScreener returns up to 30 pairs per token; we filter to dexId=meteora
// ---------------------------------------------------------------------------
async function fetchMeteoraPairs(): Promise<{ pairs: DexPair[]; error?: string }> {
  try {
    const res = await axios.get<{ pairs: DexPair[] }>(
      `${DEXSCREENER_SEARCH}${WSOL}`,
      { timeout: 15_000 }
    )
    const all = Array.isArray(res.data?.pairs) ? res.data.pairs : []
    const meteora = all.filter((p) => p.dexId === 'meteora')
    console.log(`[scanner] DexScreener returned ${all.length} total, ${meteora.length} Meteora`)
    return { pairs: meteora }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status  = (err as { response?: { status?: number } })?.response?.status
    const detail  = status ? `HTTP ${status}: ${message}` : message
    return { pairs: [], error: `DexScreener API failed — ${detail}` }
  }
}

// ---------------------------------------------------------------------------
// Pre-filter using DexScreener liquidity/volume/age
// ---------------------------------------------------------------------------
function applyPreFilter(pair: DexPair): boolean {
  const liquidity = pair.liquidity?.usd  ?? 0
  const volume    = pair.volume?.h24     ?? 0
  const ageHours  = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60)
    : 0

  return (
    volume    >= PRE_FILTER.minVolume24hUsd &&
    liquidity >= PRE_FILTER.minLiquidityUsd &&
    liquidity <= PRE_FILTER.maxLiquidityUsd &&
    (ageHours === 0 || ageHours <= PRE_FILTER.maxAgeHours)
  )
}

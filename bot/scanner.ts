import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getStrategyForToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import type { TokenMetrics } from '@/lib/types'

const METEORA_PAIR_ALL = 'https://dlmm-api.meteora.ag/pair/all'

// Meteora blocks serverless egress IPs without a browser-like User-Agent
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://app.meteora.ag',
  'Referer': 'https://app.meteora.ag/',
}

const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 50_000_000,
  maxAgeHours: 72,
}

const MIN_SCORE_TO_OPEN = parseInt(process.env.MIN_SCORE_TO_OPEN ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

interface MeteoraPair {
  address: string
  name: string
  mint_x: string
  mint_y: string
  liquidity: string
  current_price: number
  trade_volume_24h: string
  fees_24h: string
  bin_step: number
  base_fee_percentage: string
  created_at?: string
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

  const { pairs, error: fetchError } = await fetchMeteoraPairs()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return { scanned: 0, candidates: 0, opened: 0, error: fetchError }
  }
  console.log(`[scanner] fetched ${pairs.length} pairs from Meteora`)

  const preFiltered = pairs.filter(applyPreFilter)
  console.log(`[scanner] ${preFiltered.length} passed pre-filter`)

  let candidateCount = 0
  let openedCount = 0

  for (const pair of preFiltered) {
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    try {
      const tokenAddress = pair.mint_x
      const symbol = pair.name.split('-')[0] ?? pair.name

      const { data: existing } = await supabase
        .from('candidates')
        .select('id')
        .eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .limit(1)
      if (existing && existing.length > 0) continue

      const { data: existingPosition } = await supabase
        .from('positions')
        .select('id')
        .eq('token_address', tokenAddress)
        .in('status', ['active', 'out_of_range'])
        .limit(1)
      if (existingPosition && existingPosition.length > 0) continue

      const dexData = await fetchDexScreenerEnrichment(tokenAddress)
      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      const rugScore = await checkRugscore(tokenAddress)

      const liquidityUsd = parseFloat(pair.liquidity)
      const volume24h = parseFloat(pair.trade_volume_24h)

      const ageHours = pair.created_at
        ? (Date.now() - new Date(pair.created_at).getTime()) / (1000 * 60 * 60)
        : (dexData?.ageHours ?? 999)

      const metrics: TokenMetrics = {
        address: tokenAddress,
        symbol,
        mcUsd: dexData?.mcUsd ?? 0,
        volume24h,
        liquidityUsd,
        topHolderPct: holderData.topHolderPct,
        holderCount: holderData.holderCount,
        ageHours,
        rugcheckScore: rugScore,
        priceUsd: pair.current_price,
        poolAddress: pair.address,
        dexId: 'meteora',
      }

      const strategy = getStrategyForToken(metrics)
      if (!strategy) {
        console.log(
          `[scanner] ${symbol} — no strategy matched` +
          ` (mc=$${metrics.mcUsd.toFixed(0)}, vol=$${volume24h.toFixed(0)},` +
          ` holders=${metrics.holderCount}, rug=${rugScore}, age=${ageHours.toFixed(1)}h)`
        )
        continue
      }

      const score = scoreCandidate(metrics)

      await supabase.from('candidates').insert({
        token_address: metrics.address,
        symbol: metrics.symbol,
        score,
        strategy_matched: strategy.id,
        mc_at_scan: metrics.mcUsd,
        volume_24h: metrics.volume24h,
        holder_count: metrics.holderCount,
        rugcheck_score: metrics.rugcheckScore,
        top_holder_pct: metrics.topHolderPct,
        scanned_at: new Date().toISOString(),
      })

      candidateCount++
      console.log(`[scanner] candidate: ${symbol} → ${strategy.id} (score: ${score})`)

      await sendAlert({
        type: 'candidate_found',
        symbol,
        strategy: strategy.id,
        score,
        mcUsd: metrics.mcUsd,
        volume24h: metrics.volume24h,
      })

      if (score >= MIN_SCORE_TO_OPEN) {
        const positionId = await openPosition(metrics, strategy)
        if (positionId) {
          openedCount++
          await sendAlert({
            type: 'position_opened',
            symbol,
            strategy: strategy.id,
            solDeposited: strategy.position.maxSolPerPosition,
            entryPrice: metrics.priceUsd,
          })
        }
      }
    } catch (err) {
      console.error(`[scanner] error processing ${pair.name}:`, err)
    }
  }

  console.log(`[scanner] done — scanned: ${preFiltered.length}, candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: preFiltered.length, candidates: candidateCount, opened: openedCount }
}

async function fetchMeteoraPairs(): Promise<{ pairs: MeteoraPair[]; error?: string }> {
  try {
    const res = await axios.get<MeteoraPair[]>(METEORA_PAIR_ALL, {
      headers: BROWSER_HEADERS,
      timeout: 20_000,
    })
    const pairs = Array.isArray(res.data) ? res.data : []
    console.log(`[scanner] Meteora returned ${pairs.length} raw pairs`)
    return { pairs }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status = (err as { response?: { status?: number } })?.response?.status
    const detail = status ? `HTTP ${status}: ${message}` : message
    return { pairs: [], error: `Meteora API failed — ${detail}` }
  }
}

async function fetchDexScreenerEnrichment(
  tokenAddress: string
): Promise<{ mcUsd: number; ageHours: number } | null> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { timeout: 8_000 }
    )
    const pairs = res.data?.pairs ?? []
    if (pairs.length === 0) return null

    const best = [...pairs].sort(
      (a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
        (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0]

    const mcUsd = best.marketCap ?? best.fdv ?? 0
    const ageHours = best.pairCreatedAt
      ? (Date.now() - best.pairCreatedAt) / (1000 * 60 * 60)
      : 999

    return { mcUsd, ageHours }
  } catch {
    return null
  }
}

function applyPreFilter(pair: MeteoraPair): boolean {
  const liquidity = parseFloat(pair.liquidity)
  const volume = parseFloat(pair.trade_volume_24h)
  const ageHours = pair.created_at
    ? (Date.now() - new Date(pair.created_at).getTime()) / (1000 * 60 * 60)
    : 0

  return (
    volume >= PRE_FILTER.minVolume24hUsd &&
    liquidity >= PRE_FILTER.minLiquidityUsd &&
    liquidity <= PRE_FILTER.maxLiquidityUsd &&
    (ageHours === 0 || ageHours <= PRE_FILTER.maxAgeHours)
  )
}

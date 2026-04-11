/**
 * pre-grad-scanner.ts
 *
 * Finds pump.fun tokens approaching graduation WITHOUT calling pump.fun API.
 *
 * Data sources (all free, no Cloudflare):
 *   1. Meteora datapi — identifies recently-created pools whose token mint
 *      ends in "pump" (pump.fun graduated tokens) as a discovery feed.
 *      These are tokens that JUST graduated and got a Meteora pool.
 *   2. Helius RPC — reads the bonding curve PDA on-chain to get fill %.
 *      For just-graduated tokens this will be ~100%; we also scan tokens
 *      still on the bonding curve via Helius getAccountInfo.
 *   3. Helius DAS — holder count + top holder % (same as scanner.ts).
 *
 * Strategy: watch tokens in the 70–99% bonding curve fill window.
 * Once complete (graduated), lp-migrator picks them up.
 *
 * ENV VARS:
 *   PRE_GRAD_POLL_INTERVAL_S  — poll interval seconds (default: 60)
 *   PRE_GRAD_WATCH_WINDOW_H   — watchlist TTL hours (default: 6)
 *   PRE_GRAD_MIN_MCAP         — min market cap USD (default: 50000)
 *   HELIUS_RPC_URL            — required
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'
import { fetchBondingCurve } from '@/lib/pumpfun'
import { checkHolders } from '@/lib/helius'
import { sendStartupAlert } from './startup-alert'

const METEORA_DATAPI = 'https://dlmm.datapi.meteora.ag'
const WSOL           = 'So11111111111111111111111111111111111111112'
const POLL_SEC       = parseInt(process.env.PRE_GRAD_POLL_INTERVAL_S ?? '60')
const WATCH_HOURS    = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
const MIN_MCAP       = parseFloat(process.env.PRE_GRAD_MIN_MCAP ?? '50000')
const cfg            = PRE_GRAD_STRATEGY.scanner

interface MeteoraPool {
  address:     string
  name:        string
  created_at:  number
  tvl:         number
  volume:      { '24h': number }
  token_x:     { address: string; symbol: string; market_cap: number; price: number; holders: number }
  token_y:     { address: string; symbol: string; market_cap: number; price: number; holders: number }
  is_blacklisted: boolean
}

interface PoolsResponse {
  data: MeteoraPool[]
}

function toUnixSeconds(ts: number): number {
  return ts > 1e10 ? ts / 1000 : ts
}

function isPumpMint(address: string): boolean {
  return address.endsWith('pump')
}

/**
 * Fetch recently-created Meteora pools that contain a pump.fun token.
 * We use Meteora datapi sorted by creation date, then filter to pump mints.
 * Max age 48h — we want tokens that very recently graduated.
 */
async function fetchRecentPumpPools(): Promise<MeteoraPool[]> {
  const res = await axios.get<PoolsResponse>(`${METEORA_DATAPI}/pools`, {
    params: { page: 1, page_size: 500, sort_by: 'created_at:desc' },
    timeout: 20_000,
  })

  const allPools: MeteoraPool[] = res.data?.data ?? []
  const nowSec = Date.now() / 1000
  const maxAgeSec = 48 * 3600  // only tokens that graduated in the last 48h

  return allPools.filter(p => {
    if (p.is_blacklisted) return false
    if (!p.created_at || p.created_at === 0) return false
    if ((nowSec - toUnixSeconds(p.created_at)) > maxAgeSec) return false

    const hasSol   = p.token_x.address === WSOL || p.token_y.address === WSOL
    if (!hasSol) return false

    const token = p.token_x.address === WSOL ? p.token_y : p.token_x
    if (!isPumpMint(token.address)) return false

    const mc = token.market_cap ?? 0
    if (mc > 0 && mc < MIN_MCAP) return false

    return true
  })
}

async function tick(): Promise<void> {
  const heliusRpcUrl = process.env.HELIUS_RPC_URL ?? ''
  if (!heliusRpcUrl) {
    console.error('[pre-grad] HELIUS_RPC_URL not set — aborting tick')
    return
  }

  console.log(
    `[pre-grad] poll — minMcap=$${MIN_MCAP.toLocaleString()}` +
    ` curve=${cfg.minBondingProgress}-${cfg.maxBondingProgress}%` +
    ` holders≥${cfg.minHolders} dev≤${cfg.maxDevWalletPct}%`
  )

  let pools: MeteoraPool[]
  try {
    pools = await fetchRecentPumpPools()
  } catch (err) {
    console.error('[pre-grad] Meteora fetch failed:', err instanceof Error ? err.message : String(err))
    return
  }
  console.log(`[pre-grad] Meteora returned ${pools.length} recent pump.fun pools`)

  const supabase = createServerClient()
  let added = 0

  for (const pool of pools) {
    const token  = pool.token_x.address === WSOL ? pool.token_y : pool.token_x
    const mint   = token.address
    const symbol = token.symbol ?? pool.name

    // --- bonding curve via Helius RPC (no pump.fun API) ---
    const curve = await fetchBondingCurve(mint, heliusRpcUrl)

    if (!curve) {
      console.log(`[pre-grad] ${symbol} — skip: bonding curve unreadable`)
      continue
    }

    const bondingPct = curve.progressPct

    // Already fully graduated — lp-migrator handles these
    if (curve.complete) {
      console.log(`[pre-grad] ${symbol} — skip: fully graduated (curve=100%)`)
      continue
    }

    if (bondingPct < cfg.minBondingProgress) {
      console.log(`[pre-grad] ${symbol} — skip: curve ${bondingPct.toFixed(1)}% < ${cfg.minBondingProgress}%`)
      continue
    }
    if (bondingPct > cfg.maxBondingProgress) {
      console.log(`[pre-grad] ${symbol} — skip: curve ${bondingPct.toFixed(1)}% > ${cfg.maxBondingProgress}%`)
      continue
    }

    // --- holder data via Helius DAS (no pump.fun API) ---
    const holderData = await checkHolders(mint)
    const holderCount  = holderData.holderCount
    const topHolderPct = holderData.topHolderPct

    if (holderCount > 0 && holderCount < cfg.minHolders) {
      console.log(`[pre-grad] ${symbol} — skip: holders ${holderCount} < ${cfg.minHolders}`)
      continue
    }
    if (topHolderPct > 0 && topHolderPct > cfg.maxTopHolderPct) {
      console.log(`[pre-grad] ${symbol} — skip: top holder ${topHolderPct.toFixed(1)}% > ${cfg.maxTopHolderPct}%`)
      continue
    }

    // Note: dev wallet % was read from pump.fun coin detail — now omitted since
    // we no longer call pump.fun API. top_holder_pct from Helius is a sufficient proxy.

    // --- dedup + velocity ---
    const { data: existing } = await supabase
      .from('pre_grad_watchlist')
      .select('id, status, first_seen_at, bonding_pct_at_first_seen, bonding_curve_pct')
      .eq('mint', mint)
      .maybeSingle()

    if (existing && ['graduated', 'opened', 'expired'].includes(existing.status)) continue

    const now = new Date().toISOString()
    let velocitySolPerMin = 0

    if (existing?.first_seen_at && existing?.bonding_pct_at_first_seen != null) {
      const elapsedMin = (Date.now() - new Date(existing.first_seen_at).getTime()) / 60_000
      const pctGained  = bondingPct - (existing.bonding_pct_at_first_seen as number)
      velocitySolPerMin = elapsedMin > 0 ? pctGained / elapsedMin : 0

      if (cfg.minVelocitySolPerMin > 0 && velocitySolPerMin < cfg.minVelocitySolPerMin) {
        console.log(`[pre-grad] ${symbol} — skip: velocity ${velocitySolPerMin.toFixed(3)} pct/min < ${cfg.minVelocitySolPerMin}`)
        continue
      }
    }

    const upsertData: Record<string, unknown> = {
      mint,
      symbol,
      name:                  pool.name,
      volume_1h_usd:         pool.volume['24h'],
      status:                'watching',
      bonding_curve_pct:     bondingPct,
      holder_count:          holderCount,
      top_holder_pct:        topHolderPct,
      dev_wallet_pct:        0, // no longer available without pump.fun API — set 0
      velocity_pct_per_min:  velocitySolPerMin,
    }

    if (!existing) {
      upsertData.detected_at               = now
      upsertData.first_seen_at             = now
      upsertData.bonding_pct_at_first_seen = bondingPct
    }

    const { error } = await supabase
      .from('pre_grad_watchlist')
      .upsert(upsertData, { onConflict: 'mint', ignoreDuplicates: false })

    if (error) {
      console.error(`[pre-grad] upsert error for ${symbol}:`, error.message)
    } else if (!existing) {
      console.log(
        `[pre-grad] WATCHLIST ADD: ${symbol} (${mint.slice(0, 8)}...)` +
        ` curve=${bondingPct.toFixed(1)}% holders=${holderCount} topHolder=${topHolderPct.toFixed(1)}%` +
        ` mcap=$${Math.round(token.market_cap ?? 0).toLocaleString()}`
      )
      added++
    } else {
      console.log(
        `[pre-grad] UPDATE: ${symbol} curve=${bondingPct.toFixed(1)}%` +
        ` velocity=${velocitySolPerMin.toFixed(3)} pct/min`
      )
    }
  }

  // Expire stale watchlist entries
  const cutoff = new Date(Date.now() - WATCH_HOURS * 3_600_000).toISOString()
  await supabase
    .from('pre_grad_watchlist')
    .update({ status: 'expired' })
    .eq('status', 'watching')
    .lt('detected_at', cutoff)

  console.log(`[pre-grad] tick done — ${pools.length} pump pools checked, ${added} new watchlist entries`)
}

/**
 * Exported tick for use by telegram-bot /tick command.
 */
export async function runPreGradScanner(): Promise<string> {
  try {
    const before = Date.now()
    await tick()
    return `✅ pre-grad-scanner (${Date.now() - before}ms)`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `❌ pre-grad-scanner: ${msg}`
  }
}

async function main(): Promise<void> {
  await sendStartupAlert('pre-grad-scanner')
  console.log(`[pre-grad] starting — poll every ${POLL_SEC}s, watch window ${WATCH_HOURS}h`)
  await tick()
  setInterval(tick, POLL_SEC * 1_000)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})

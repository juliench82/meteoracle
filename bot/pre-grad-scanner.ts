/**
 * pre-grad-scanner.ts
 *
 * Scans ALL active pump.fun bonding curves on-chain via Helius getProgramAccounts.
 * No pump.fun API. No Meteora. Pure on-chain.
 *
 * BondingCurve account layout (Anchor, 8-byte discriminator):
 *   0-7:   discriminator
 *   8-15:  virtualTokenReserves  u64 LE
 *  16-23:  virtualSolReserves    u64 LE
 *  24-31:  realTokenReserves     u64 LE
 *  32-39:  realSolReserves       u64 LE
 *  40-47:  tokenTotalSupply      u64 LE
 *  48:     complete              bool
 *  49-80:  mint                  Pubkey (32 bytes)
 *
 * ENV VARS:
 *   PRE_GRAD_POLL_INTERVAL_S  poll interval seconds (default: 60)
 *   PRE_GRAD_WATCH_WINDOW_H   watchlist TTL hours (default: 6)
 *   HELIUS_RPC_URL            required
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'
import { checkHolders } from '@/lib/helius'
import { sendStartupAlert } from './startup-alert'

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const BONDING_CURVE_SIZE = 81
const INITIAL_VIRTUAL_SOL    = 30_000_000_000
const GRADUATION_VIRTUAL_SOL = 115_000_000_000

const POLL_SEC    = parseInt(process.env.PRE_GRAD_POLL_INTERVAL_S ?? '60')
const WATCH_HOURS = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
const cfg         = PRE_GRAD_STRATEGY.scanner

interface DecodedCurve {
  bondingCurveAddress: string
  mintAddress: string
  progressPct: number
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function bs58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0]
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58) }
  }
  let result = ''
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += '1'
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58[digits[i]]
  return result
}

function decodeAccount(pubkey: string, data: Buffer): DecodedCurve | null {
  if (data.length < BONDING_CURVE_SIZE) return null
  const complete = data[48] === 1
  if (complete) return null

  const virtualSolReserves = data.readBigUInt64LE(16)
  const mintBytes = data.slice(49, 81)
  if (mintBytes.length < 32) return null

  let mintAddress: string
  try { mintAddress = bs58Encode(mintBytes) } catch { return null }

  let progressPct: number
  if (virtualSolReserves > BigInt(INITIAL_VIRTUAL_SOL)) {
    const num = Number(virtualSolReserves) - INITIAL_VIRTUAL_SOL
    const den = GRADUATION_VIRTUAL_SOL - INITIAL_VIRTUAL_SOL
    progressPct = Math.min(100, Math.max(0, (num / den) * 100))
  } else {
    progressPct = 0
  }

  return { bondingCurveAddress: pubkey, mintAddress, progressPct }
}

async function fetchActiveBondingCurves(heliusRpcUrl: string): Promise<DecodedCurve[]> {
  const resp = await axios.post(
    heliusRpcUrl,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        PUMP_PROGRAM_ID,
        {
          encoding: 'base64',
          filters: [
            { dataSize: BONDING_CURVE_SIZE },
            // complete=false: byte 48 must be 0x00
            { memcmp: { offset: 48, bytes: bs58Encode(new Uint8Array([0])) } },
          ],
        },
      ],
    },
    { timeout: 30_000 }
  )

  const accounts: Array<{ pubkey: string; account: { data: [string, string] } }> =
    resp.data?.result ?? []

  const curves: DecodedCurve[] = []
  for (const { pubkey, account } of accounts) {
    const raw = Buffer.from(account.data[0], 'base64')
    const decoded = decodeAccount(pubkey, raw)
    if (decoded) curves.push(decoded)
  }
  return curves
}

async function tick(): Promise<void> {
  const heliusRpcUrl = process.env.HELIUS_RPC_URL ?? ''
  if (!heliusRpcUrl) {
    console.error('[pre-grad] HELIUS_RPC_URL not set')
    return
  }

  console.log(
    `[pre-grad] poll via getProgramAccounts` +
    ` curve=${cfg.minBondingProgress}-${cfg.maxBondingProgress}%` +
    ` holders>=${cfg.minHolders} topHolder<=${cfg.maxTopHolderPct}%`
  )

  let allCurves: DecodedCurve[]
  try {
    allCurves = await fetchActiveBondingCurves(heliusRpcUrl)
  } catch (err) {
    console.error('[pre-grad] getProgramAccounts failed:', err instanceof Error ? err.message : String(err))
    return
  }
  console.log(`[pre-grad] ${allCurves.length} active bonding curves`)

  const inWindow = allCurves.filter(
    c => c.progressPct >= cfg.minBondingProgress && c.progressPct <= cfg.maxBondingProgress
  )
  console.log(`[pre-grad] ${inWindow.length} in window (${cfg.minBondingProgress}-${cfg.maxBondingProgress}%)`)

  const supabase = createServerClient()
  let added = 0

  for (const curve of inWindow) {
    const mint   = curve.mintAddress
    const symbol = mint.slice(0, 8)

    const holderData   = await checkHolders(mint)
    const holderCount  = holderData.holderCount
    const topHolderPct = holderData.topHolderPct

    if (holderCount > 0 && holderCount < cfg.minHolders) {
      console.log(`[pre-grad] ${symbol}... skip: holders ${holderCount} < ${cfg.minHolders}`)
      continue
    }
    if (topHolderPct > 0 && topHolderPct > cfg.maxTopHolderPct) {
      console.log(`[pre-grad] ${symbol}... skip: topHolder ${topHolderPct.toFixed(1)}% > ${cfg.maxTopHolderPct}%`)
      continue
    }

    const bondingPct = curve.progressPct

    const { data: existing } = await supabase
      .from('pre_grad_watchlist')
      .select('id, status, first_seen_at, bonding_pct_at_first_seen')
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
        console.log(`[pre-grad] ${symbol}... skip: velocity ${velocitySolPerMin.toFixed(3)} pct/min < ${cfg.minVelocitySolPerMin}`)
        continue
      }
    }

    const upsertData: Record<string, unknown> = {
      mint,
      symbol,
      name:                 symbol,
      volume_1h_usd:        0,
      status:               'watching',
      bonding_curve_pct:    bondingPct,
      holder_count:         holderCount,
      top_holder_pct:       topHolderPct,
      dev_wallet_pct:       0,
      velocity_pct_per_min: velocitySolPerMin,
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
        `[pre-grad] WATCHLIST ADD: ${symbol}... (${mint})` +
        ` curve=${bondingPct.toFixed(1)}% holders=${holderCount} topHolder=${topHolderPct.toFixed(1)}%`
      )
      added++
    } else {
      console.log(`[pre-grad] UPDATE: ${symbol}... curve=${bondingPct.toFixed(1)}% vel=${velocitySolPerMin.toFixed(3)}/min`)
    }
  }

  const cutoff = new Date(Date.now() - WATCH_HOURS * 3_600_000).toISOString()
  await supabase
    .from('pre_grad_watchlist')
    .update({ status: 'expired' })
    .eq('status', 'watching')
    .lt('detected_at', cutoff)

  console.log(`[pre-grad] tick done total=${allCurves.length} in-window=${inWindow.length} added=${added}`)
}

export async function runPreGradScanner(): Promise<string> {
  try {
    const before = Date.now()
    await tick()
    return `ok pre-grad-scanner (${Date.now() - before}ms)`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `err pre-grad-scanner: ${msg}`
  }
}

async function main(): Promise<void> {
  await sendStartupAlert('pre-grad-scanner')
  console.log(`[pre-grad] starting poll every ${POLL_SEC}s, watch window ${WATCH_HOURS}h`)
  await tick()
  setInterval(tick, POLL_SEC * 1_000)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})

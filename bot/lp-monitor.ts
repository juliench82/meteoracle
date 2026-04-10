/**
 * lp-monitor.ts  — Day 7
 *
 * Polls lp_positions for all active Meteora DLMM LP positions every 5 minutes.
 * For each position:
 *   1. Checks if position is still in range via DLMM SDK
 *   2. Tracks out-of-range duration (oor_since_at)
 *   3. Claims + logs fees earned
 *   4. Exits on: OOR > maxOorMinutes, age > maxHoldHours
 *   5. On exit: removes liquidity, claims fees, updates lp_positions, Telegram alert
 *
 * BOT_DRY_RUN=true  → simulates range checks, no on-chain tx
 * BOT_DRY_RUN=false → real DLMM interactions
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import DLMM from '@meteora-ag/dlmm'
import {
  PublicKey, Transaction,
} from '@solana/web3.js'
import BN from 'bn.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { sendTelegram } from './telegram'
import { POST_GRAD_LP_STRATEGY } from '../strategies/post-grad-lp'

const DRY_RUN       = process.env.BOT_DRY_RUN !== 'false'
const POLL_INTERVAL = parseInt(process.env.LP_MONITOR_POLL_SEC ?? '300') * 1_000  // default 5min
const cfg           = POST_GRAD_LP_STRATEGY

console.log(`[lp-monitor] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[lp-monitor] maxOorMinutes=${cfg.exits.maxOorMinutes} | maxHoldHours=${cfg.exits.maxHoldHours}h`)
console.log(`[lp-monitor] poll interval: ${POLL_INTERVAL / 1000}s`)

interface LpPosition {
  id:              string
  spot_position_id: string | null
  mint:            string
  symbol:          string
  pool_address:    string
  position_pubkey: string | null
  token_amount:    number
  sol_deposited:   number
  bin_lower:       number
  bin_upper:       number
  entry_bin:       number
  entry_price_usd: number
  fees_earned_sol: number
  status:          string
  in_range:        boolean
  oor_since_at:    string | null
  dry_run:         boolean
  opened_at:       string
}

type ExitReason = 'oor_timeout' | 'max_hold' | 'manual'

async function sendLegacyTx(
  tx: Transaction,
  signers: import('@solana/web3.js').Signer[]
): Promise<string> {
  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

async function closeLpPosition(
  pos:    LpPosition,
  reason: ExitReason,
): Promise<void> {
  const supabase = createServerClient()
  const label    = `[lp-monitor][${pos.symbol}]`

  console.log(`${label} EXIT ${reason} — closing LP position`)

  let feesEarned = pos.fees_earned_sol
  let txClose    = 'dry-run'

  if (!pos.dry_run && pos.position_pubkey) {
    const connection = getConnection()
    const wallet     = getWallet()

    try {
      const dlmmPool    = await DLMM.create(connection, new PublicKey(pos.pool_address))
      const positionKey = new PublicKey(pos.position_pubkey)

      // Claim fees first
      try {
        const claimTxs = await dlmmPool.claimAllRewards({
          owner:     wallet.publicKey,
          positions: [{ publicKey: positionKey } as never],
        })
        for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
          const sig = await sendLegacyTx(tx, [wallet])
          console.log(`${label} fees claimed ✔ sig: ${sig}`)
        }
      } catch (e) {
        console.warn(`${label} fee claim failed (continuing):`, e)
      }

      // Remove liquidity + close position account
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
      const userPos = userPositions.find(p => p.publicKey.toBase58() === pos.position_pubkey)

      if (userPos) {
        const { lowerBinId, upperBinId } = userPos.positionData
        const removeTx = await dlmmPool.removeLiquidity({
          position:         positionKey,
          user:             wallet.publicKey,
          fromBinId:        lowerBinId,
          toBinId:          upperBinId,
          bps:              new BN(10_000),
          shouldClaimAndClose: true,
        })
        for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
          txClose = await sendLegacyTx(tx, [wallet])
          console.log(`${label} liquidity removed ✔ sig: ${txClose}`)
        }
      } else {
        console.warn(`${label} position not found on-chain — may already be closed`)
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${label} close failed:`, msg)
      await supabase.from('bot_logs').insert({
        level: 'error', event: 'lp_close_failed',
        payload: { id: pos.id, symbol: pos.symbol, reason, error: msg },
      })
      await sendTelegram(`❌ LP CLOSE FAILED ${pos.symbol}\n${msg}`)
      return
    }
  }

  // Current price for rough PnL estimate
  let exitPriceUsd = 0
  try {
    const priceRes = await axios.get('https://api.jup.ag/price/v2', { params: { ids: pos.mint }, timeout: 8_000 })
    exitPriceUsd = parseFloat(priceRes.data?.data?.[pos.mint]?.price ?? '0')
  } catch {}

  const pnlSol = exitPriceUsd > 0 && pos.entry_price_usd > 0
    ? pos.token_amount * (exitPriceUsd - pos.entry_price_usd) + feesEarned
    : feesEarned

  await supabase.from('lp_positions').update({
    status:       'closed',
    closed_at:    new Date().toISOString(),
    close_reason: reason,
    fees_earned_sol: feesEarned,
    pnl_sol:      pnlSol,
    tx_close:     txClose,
  }).eq('id', pos.id)

  const reasonLabel = reason === 'oor_timeout' ? '📤 Out of range' : reason === 'max_hold' ? '⏰ Max hold' : '🛑 Manual'
  const dryLabel    = pos.dry_run ? '[DRY-RUN] ' : ''
  const ageHours    = ((Date.now() - new Date(pos.opened_at).getTime()) / 3_600_000).toFixed(1)

  await sendTelegram(
    `🔴 ${dryLabel}LP CLOSED ${pos.symbol}\n` +
    `📋 Reason: ${reasonLabel}\n` +
    `💰 Fees earned: ${feesEarned.toFixed(4)} SOL\n` +
    `📈 PnL est: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
    `⏱️ Held: ${ageHours}h` +
    (!pos.dry_run && txClose !== 'dry-run' ? `\n🔗 https://solscan.io/tx/${txClose}` : '')
  )

  console.log(`${label} closed — reason=${reason} fees=${feesEarned.toFixed(4)} pnl=${pnlSol.toFixed(4)} SOL`)
}

async function tick(): Promise<void> {
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('lp_positions')
    .select('*')
    .eq('status', 'active')

  if (error) {
    console.error('[lp-monitor] fetch error:', error.message)
    return
  }

  const positions = (data ?? []) as LpPosition[]
  if (positions.length === 0) {
    console.log('[lp-monitor] no active LP positions')
    return
  }

  console.log(`[lp-monitor] monitoring ${positions.length} active LP position(s)`)

  const connection = getConnection()
  const wallet     = DRY_RUN ? null : getWallet()

  for (const pos of positions) {
    const label      = `[lp-monitor][${pos.symbol}]`
    const ageMinutes = (Date.now() - new Date(pos.opened_at).getTime()) / 60_000
    const ageHours   = ageMinutes / 60

    // Max hold check
    if (ageHours >= cfg.exits.maxHoldHours) {
      console.log(`${label} max hold reached (${ageHours.toFixed(1)}h) — closing`)
      await closeLpPosition(pos, 'max_hold')
      continue
    }

    let currentlyInRange = pos.in_range

    if (!pos.dry_run && pos.position_pubkey && wallet) {
      try {
        const dlmmPool  = await DLMM.create(connection, new PublicKey(pos.pool_address))
        const activeBin = await dlmmPool.getActiveBin()
        currentlyInRange = activeBin.binId >= pos.bin_lower && activeBin.binId <= pos.bin_upper

        // Periodic fee snapshot
        try {
          const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
          const userPos = userPositions.find(p => p.publicKey.toBase58() === pos.position_pubkey)
          if (userPos) {
            const pendingFeeX = userPos.positionData.feeX?.toNumber() ?? 0
            const pendingFeeY = userPos.positionData.feeY?.toNumber() ?? 0
            const feeSol      = (pendingFeeX + pendingFeeY) / 1e9
            if (feeSol > pos.fees_earned_sol) {
              await supabase.from('lp_positions').update({ fees_earned_sol: feeSol }).eq('id', pos.id)
            }
          }
        } catch {}

      } catch (err) {
        console.warn(`${label} DLMM range check failed:`, err)
        continue
      }
    } else if (pos.dry_run) {
      // Simulate occasional OOR for testing
      currentlyInRange = Math.random() > 0.1
    }

    // Update in_range state
    if (currentlyInRange !== pos.in_range) {
      await supabase.from('lp_positions').update({
        in_range:     currentlyInRange,
        oor_since_at: currentlyInRange ? null : new Date().toISOString(),
      }).eq('id', pos.id)
      console.log(`${label} range state changed → ${currentlyInRange ? 'IN range ✅' : 'OUT of range ⚠️'}`)
    }

    // OOR timeout check
    if (!currentlyInRange && pos.oor_since_at) {
      const oorMinutes = (Date.now() - new Date(pos.oor_since_at).getTime()) / 60_000
      console.log(`${label} OOR for ${oorMinutes.toFixed(1)}min (limit ${cfg.exits.maxOorMinutes}min)`)
      if (oorMinutes >= cfg.exits.maxOorMinutes) {
        await closeLpPosition(pos, 'oor_timeout')
      }
    }
  }
}

async function main(): Promise<void> {
  await tick()
  setInterval(tick, POLL_INTERVAL)
}

main().catch(err => {
  console.error('[lp-monitor] fatal:', err)
  process.exit(1)
})

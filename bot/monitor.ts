import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { checkMoonboyPositions } from './moonboy-executor'
import { retryStrandedSells } from '@/lib/swap'
import { getBotState } from '@/lib/botState'
import { getOpenLpPositions, saveOpenLpPositions } from '@/lib/local-state'
import { closePosition } from '@/bot/executor/close'
import { getConnection, getWallet } from '@/lib/solana'
import { getDLMM } from '@/bot/executor/utils'
import { PublicKey } from '@solana/web3.js'

/**
 * Ultra-minimal monitor (local-state + on-chain only).
 * - Moonboy 2x exits
 * - Stranded sell retries
 * - Basic LP exits: out-of-range time + max duration (no heavy rebalance/orphan logic)
 */

let tickCount = 0
const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1000
const LP_MONITOR_ENABLED = process.env.LP_MONITOR_ENABLED !== 'false'

const DEFAULT_OOR_MINUTES = 30
const DEFAULT_MAX_DURATION_HOURS = 12

export async function monitorPositions() {
  return runTick()
}

console.log('[monitor] ultra-minimal (local-state + on-chain OOR + duration exits)')

async function runTick(): Promise<{ checked: number; closed: number }> {
  const stats = { checked: 0, closed: 0 }

  const botState = await getBotState().catch(() => ({ enabled: false, dry_run: true, paused: false }))
  if (botState.paused) {
    console.log('[lp-monitor] bot is paused — skipping tick')
    return stats
  }

  tickCount++
  console.log('[lp-monitor] tick start')

  await checkMoonboyPositions().catch(err => console.error('[monitor] moonboy failed:', err))
  await retryStrandedSells().catch(err => console.error('[monitor] stranded sells failed:', err))

  if (!LP_MONITOR_ENABLED) {
    console.log('[lp-monitor] disabled')
    return stats
  }

  // === Minimal LP exit logic (local-state + on-chain DLMM) ===
  const positions = getOpenLpPositions().filter((p: any) => ['open', 'active'].includes(p.status))
  stats.checked = positions.length

  if (positions.length > 0) {
    const wallet = getWallet()
    const connection = getConnection()

    for (const pos of positions) {
      try {
        if (!pos.pool_address || !pos.position_pubkey) continue

        const DLMM = await getDLMM()
        const dlmmPool = await DLMM.create(connection, new PublicKey(pos.pool_address))
        const activeBin = await dlmmPool.getActiveBin()

        // Get the actual on-chain position to read its bin range
        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
        const onChainPos = userPositions.find((p: any) => p.publicKey.toBase58() === pos.position_pubkey)

        if (!onChainPos?.positionData) continue

        const { lowerBinId, upperBinId } = onChainPos.positionData
        const isOOR = activeBin.binId < lowerBinId || activeBin.binId > upperBinId

        const now = Date.now()
        let oorSince = pos.oor_since ? new Date(pos.oor_since).getTime() : null

        if (isOOR) {
          if (!oorSince) {
            oorSince = now
            pos.oor_since = new Date(oorSince).toISOString()
            // persist the timestamp immediately
            const all = getOpenLpPositions()
            const idx = all.findIndex((p: any) => p.id === pos.id)
            if (idx !== -1) { all[idx].oor_since = pos.oor_since; saveOpenLpPositions(all) }
          }

          const oorMinutes = (now - oorSince) / 1000 / 60
          const oorLimit = pos.out_of_range_minutes ?? DEFAULT_OOR_MINUTES

          if (oorMinutes >= oorLimit) {
            console.log(`[monitor] OOR exit → ${pos.symbol} (out ${Math.round(oorMinutes)}m / ${oorLimit}m)`)
            const ok = await closePosition(pos.id, 'oor_monitor').catch(() => false)
            if (ok) stats.closed++
            continue
          }
        } else if (oorSince) {
          // back in range — clear the timer
          delete pos.oor_since
          const all = getOpenLpPositions()
          const idx = all.findIndex((p: any) => p.id === pos.id)
          if (idx !== -1) { delete all[idx].oor_since; saveOpenLpPositions(all) }
        }

        // Max duration guard
        const openedAt = pos.created_at || pos.opened_at
        if (openedAt) {
          const hoursOpen = (now - new Date(openedAt).getTime()) / 1000 / 3600
          const maxH = pos.max_duration_hours ?? DEFAULT_MAX_DURATION_HOURS
          if (hoursOpen >= maxH) {
            console.log(`[monitor] max-duration exit → ${pos.symbol} (${hoursOpen.toFixed(1)}h / ${maxH}h)`)
            const ok = await closePosition(pos.id, 'max_duration_monitor').catch(() => false)
            if (ok) stats.closed++
          }
        }
      } catch (e) {
        console.warn(`[monitor] OOR check failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
      }
    }
  }

  console.log('[lp-monitor] tick done')
  return stats
}

async function main() {
  await runTick().catch(err => console.error('[lp-monitor] first tick error:', err))

  setInterval(() => {
    runTick().catch(err => console.error('[lp-monitor] tick error:', err))
  }, MONITOR_INTERVAL_MS)
}

main().catch(err => {
  console.error('[lp-monitor] fatal error:', err)
  process.exit(1)
})

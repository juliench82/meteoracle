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

// Fallbacks only used if a position record is missing the values persisted at open time
const FALLBACK_OOR_MINUTES = 30
const FALLBACK_MAX_DURATION_HOURS = 12

function getPositionExitRules(pos: any) {
  // Values are persisted from the strategy at open time (see persistence.ts + evil-panda.ts)
  // This ensures each position respects the exact parameters that were active when it was opened.
  return {
    outOfRangeMinutes: pos.out_of_range_minutes ?? pos.metadata?.out_of_range_minutes ?? FALLBACK_OOR_MINUTES,
    maxDurationHours:  pos.max_duration_hours  ?? pos.metadata?.maxDurationHours  ?? FALLBACK_MAX_DURATION_HOURS,
    claimFeesBeforeClose: pos.claim_fees_before_close ?? pos.metadata?.claimFeesBeforeClose ?? true,
    minFeesToClaim:       pos.min_fees_to_claim       ?? pos.metadata?.minFeesToClaim       ?? 0.001,
  }
}

export async function monitorPositions() {
  return runTick()
}

async function runTick(): Promise<{ checked: number; closed: number }> {
  const stats = { checked: 0, closed: 0 }

  const botState = await getBotState().catch(() => ({ enabled: false, dry_run: true, paused: false }))
  if (botState.paused) {
    console.log('[lp-monitor] bot is paused — skipping tick')
    return stats
  }

  tickCount++ // incremented for potential future use / debugging

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

        const rules = getPositionExitRules(pos)
        const now = Date.now()
        let oorSince = pos.oor_since ? new Date(pos.oor_since).getTime() : null

        if (isOOR) {
          if (!oorSince) {
            oorSince = now
            pos.oor_since = new Date(oorSince).toISOString()
            const all = getOpenLpPositions()
            const idx = all.findIndex((p: any) => p.id === pos.id)
            if (idx !== -1) { all[idx].oor_since = pos.oor_since; saveOpenLpPositions(all) }
          }

          const oorMinutes = (now - oorSince) / 1000 / 60
          if (oorMinutes >= rules.outOfRangeMinutes) {
            console.log(`[monitor] OOR exit → ${pos.symbol} (out ${Math.round(oorMinutes)}m / ${rules.outOfRangeMinutes}m, claimFees=${rules.claimFeesBeforeClose}, minFees=${rules.minFeesToClaim})`)
            const ok = await closePosition(pos.id, 'oor_monitor').catch(() => false)
            if (ok) stats.closed++
            continue
          }
        } else if (oorSince) {
          delete pos.oor_since
          const all = getOpenLpPositions()
          const idx = all.findIndex((p: any) => p.id === pos.id)
          if (idx !== -1) { delete all[idx].oor_since; saveOpenLpPositions(all) }
        }

        // Max duration guard (using persisted strategy value)
        const openedAt = pos.created_at || pos.opened_at
        if (openedAt) {
          const hoursOpen = (now - new Date(openedAt).getTime()) / 1000 / 3600
          if (hoursOpen >= rules.maxDurationHours) {
            console.log(`[monitor] max-duration exit → ${pos.symbol} (${hoursOpen.toFixed(1)}h / ${rules.maxDurationHours}h, claimFees=${rules.claimFeesBeforeClose}, minFees=${rules.minFeesToClaim})`)
            const ok = await closePosition(pos.id, 'max_duration_monitor').catch(() => false)
            if (ok) stats.closed++
          }
        }
      } catch (e) {
        console.warn(`[monitor] OOR check failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
      }
    }
  }

  return stats
}

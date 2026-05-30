import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { checkMoonboyPositions } from './moonboy-executor'
import { retryStrandedSells } from '@/lib/swap'
import { getBotState } from '@/lib/botState'

/**
 * Ultra-minimal monitor.
 * - Moonboy 2x monitoring via local-state
 * - Stranded sell retries
 */

let tickCount = 0
const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1000
const LP_MONITOR_ENABLED = process.env.LP_MONITOR_ENABLED !== 'false'

export async function monitorPositions() {
  return runTick()
}

console.log('[monitor] ultra-minimal (local-state Moonboy + stranded sells)')

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

  // Future: LP exit logic will be re-added here using local-state + on-chain DLMM queries only.
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

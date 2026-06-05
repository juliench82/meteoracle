import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { retryStrandedSells } from '@/lib/swap'
import { getBotState } from '@/lib/botState'
import axios from 'axios'
import { getOpenLpPositions, saveOpenLpPositions } from '@/lib/local-state'
import { closePosition } from '@/bot/executor/close'
import { getConnection, getWallet } from '@/lib/solana'
import { getDLMM, getDecimalAdjustedPrice, getClaimableFeesUsd } from '@/bot/executor/utils'
import { getCurrentPoolFeeTvl24h } from '@/bot/scanner/pool-fetcher'
import { PublicKey } from '@solana/web3.js'
import {
  LP_FEE_TVL_EXIT_THRESHOLD,
  LP_OOR_EXIT_MINUTES,
  LP_NET_LOSS_SL_PCT,
  LP_NET_LOSS_SL_MIN_AGE_MIN,
  LP_MAX_DURATION_HOURS,
  LP_FEE_TVL_SAMPLE_WINDOW_H,
} from '@/lib/strategy-config'

/**
 * Ultra-minimal LP monitor (local-state + on-chain only).
 *
 * LP exit rules (48h dry-run starting point — see strategy-config + .env):
 * 1. Fee/TVL yield collapse: rolling 4h avg of pool 24h Fee/TVL < LP_FEE_TVL_EXIT_THRESHOLD (0.75%)
 * 2. Prolonged out-of-range: OOR for >= LP_OOR_EXIT_MINUTES (45min)
 * 3. Net PnL stop-loss: realized price move + fees (claimed + unclaimed) <= LP_NET_LOSS_SL_PCT (-30%)
 *    after at least LP_NET_LOSS_SL_MIN_AGE_MIN (20min) grace period
 * 4. Hard safety: position age >= LP_MAX_DURATION_HOURS (1h for fresh volatile memes — out after 60m max, other rules can fire earlier)
 *
 * All decisions + rich metrics are surfaced via Telegram close alerts.
 * No Supabase hot path.
 *
 * Dry-run simulation rows (from BOT_DRY_RUN) are supported for full open+close lifecycle testing:
 * pool-level (Fee/TVL) and time-based (duration) rules are evaluated; on-chain rules (OOR, exact netPnL) are skipped.
 */

let tickCount = 0
const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1000
const LP_MONITOR_ENABLED = process.env.LP_MONITOR_ENABLED !== 'false'

// Legacy per-position exit params (still read for backward compat with older opens).
// For the 4-rule minimal model the global LP_* constants in strategy-config are authoritative.
function getPositionExitRules(pos: any) {
  return {
    outOfRangeMinutes: pos.out_of_range_minutes ?? pos.metadata?.out_of_range_minutes ?? LP_OOR_EXIT_MINUTES,
    maxDurationHours:  pos.max_duration_hours  ?? pos.metadata?.maxDurationHours  ?? LP_MAX_DURATION_HOURS,
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

  await retryStrandedSells().catch(err => console.error('[monitor] stranded sells failed:', err))

  if (!LP_MONITOR_ENABLED) {
    console.log('[lp-monitor] disabled')
    return stats
  }

  // === LP exit rules (4-rule ultra-minimal model) ===
  const positions = getOpenLpPositions().filter((p: any) => ['open', 'active'].includes(p.status))
  stats.checked = positions.length

  if (positions.length > 0) {
    const wallet = getWallet()
    const connection = getConnection()
    const now = Date.now()

    for (const pos of positions) {
      try {
        if (!pos.pool_address) continue

        const isDrySim = pos.dry_run === true || !pos.position_pubkey

        let activeBin = null
        let onChainPos = null
        let isOOR = false
        let dlmmPool = null

        if (!isDrySim) {
          const DLMM = await getDLMM()
          dlmmPool = await DLMM.create(connection, new PublicKey(pos.pool_address))
          activeBin = await dlmmPool.getActiveBin()

          // On-chain position for bin range + amounts/fees
          const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
          onChainPos = userPositions.find((p: any) => p.publicKey.toBase58() === pos.position_pubkey)
          if (!onChainPos?.positionData) continue

          const { lowerBinId, upperBinId } = onChainPos.positionData
          isOOR = activeBin.binId < lowerBinId || activeBin.binId > upperBinId
        } else {
          console.log(`[monitor] ${pos.symbol} DRY SIM row — skipping on-chain OOR/netPnl (no real position on-chain)`)
          isOOR = false
        }

        const openedAt = pos.opened_at || pos.created_at

        // Use global config for the new minimal rules (authoritative for 48h dry-run)
        const oorMinutesThreshold = LP_OOR_EXIT_MINUTES
        const maxDurationH = LP_MAX_DURATION_HOURS
        const feeTvlThreshold = LP_FEE_TVL_EXIT_THRESHOLD
        const netLossThreshold = LP_NET_LOSS_SL_PCT
        const netLossGraceMin = LP_NET_LOSS_SL_MIN_AGE_MIN
        const sampleWindowH = LP_FEE_TVL_SAMPLE_WINDOW_H

        // ── 1. Rolling 4h Fee/TVL sampling + yield collapse check ─────────────────
        let feeTvl4hAvg: number | null = null
        try {
          const currentFeeTvl = await getCurrentPoolFeeTvl24h(pos.pool_address)
          if (currentFeeTvl != null && Number.isFinite(currentFeeTvl)) {
            const samples: Array<{ ts: number; fee_tvl_24h: number }> = Array.isArray(pos.fee_tvl_samples) ? pos.fee_tvl_samples : []
            samples.push({ ts: now, fee_tvl_24h: currentFeeTvl })

            // Prune to window
            const windowMs = sampleWindowH * 3600 * 1000
            const pruned = samples.filter((s) => now - s.ts <= windowMs)

            if (pruned.length > 0) {
              const avg = pruned.reduce((sum, s) => sum + s.fee_tvl_24h, 0) / pruned.length
              feeTvl4hAvg = Math.round(avg * 100) / 100
              pos.fee_tvl_samples = pruned
              pos.last_fee_tvl_4h_avg = feeTvl4hAvg
            } else {
              pos.fee_tvl_samples = pruned
            }

            // Persist samples (lightweight)
            const all = getOpenLpPositions()
            const idx = all.findIndex((p: any) => p.id === pos.id)
            if (idx !== -1) {
              all[idx].fee_tvl_samples = pos.fee_tvl_samples
              all[idx].last_fee_tvl_4h_avg = pos.last_fee_tvl_4h_avg
              saveOpenLpPositions(all)
            }
          }
        } catch (e) {
          // Non-fatal — we still evaluate other rules
          console.warn(`[monitor] Fee/TVL sample failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
        }

        if (feeTvl4hAvg != null && feeTvl4hAvg < feeTvlThreshold && (pos.fee_tvl_samples?.length ?? 0) >= 3) {
          const reason = `fee_tvl_yield_low_4havg_${feeTvl4hAvg.toFixed(2)}pct`
          console.log(`[monitor] FEE/TVL EXIT → ${pos.symbol} (4h avg ${feeTvl4hAvg.toFixed(2)}% < ${feeTvlThreshold}%, samples=${pos.fee_tvl_samples?.length ?? 0})`)
          const ok = await closePosition(pos.id, reason).catch(() => false)
          if (ok) stats.closed++
          continue
        }

        // For dry sim rows, compute a rough net PnL from entry price vs current market price
        // so that close alerts (e.g. on max_duration) can include Net PnL even without on-chain data.
        if (isDrySim && pos.entry_price_usd && pos.entry_price_usd > 0) {
          try {
            const mintForPrice = pos.mint || (pos.metadata && pos.metadata.mint)
            if (mintForPrice) {
              const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintForPrice}`, { timeout: 5000 })
              const pair = res.data?.pairs?.[0]
              const currentPrice = pair?.priceUsd ? parseFloat(pair.priceUsd) : null
              if (currentPrice) {
                let roughPnl = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100
                const claimable = getClaimableFeesUsd(pos) ?? 0
                if (claimable > 0 && pos.sol_deposited > 0) {
                  // rough: assume SOL ~150 USD for fee contribution; fees are usually tiny in dry sims
                  roughPnl += (claimable / (pos.sol_deposited * 150)) * 100
                }
                pos.last_net_pnl_pct = Math.round(roughPnl * 100) / 100
                const all = getOpenLpPositions()
                const idx = all.findIndex((p: any) => p.id === pos.id)
                if (idx !== -1) {
                  all[idx].last_net_pnl_pct = pos.last_net_pnl_pct
                  saveOpenLpPositions(all)
                }
              }
            }
          } catch (e) {
            // non-fatal for dry sim
          }
        }

        // ── 2. Out-of-range duration (OOR) ────────────────────────────────────────
        // Only for real on-chain positions
        if (!isDrySim) {
          let oorSince = pos.oor_since ? new Date(pos.oor_since).getTime() : null
          if (isOOR) {
            if (!oorSince) {
              oorSince = now
              pos.oor_since = new Date(oorSince).toISOString()
              const all = getOpenLpPositions()
              const idx = all.findIndex((p: any) => p.id === pos.id)
              if (idx !== -1) { all[idx].oor_since = pos.oor_since; saveOpenLpPositions(all) }
            }

            const oorMin = (now - oorSince) / 1000 / 60
            if (oorMin >= oorMinutesThreshold) {
              const reason = `oor_${Math.round(oorMin)}min`
              console.log(`[monitor] OOR EXIT → ${pos.symbol} (out ${Math.round(oorMin)}m / ${oorMinutesThreshold}m)`)
              const ok = await closePosition(pos.id, reason).catch(() => false)
              if (ok) stats.closed++
              continue
            }
          } else if (oorSince) {
            // Back in range — clear the timer
            delete pos.oor_since
            const all = getOpenLpPositions()
            const idx = all.findIndex((p: any) => p.id === pos.id)
            if (idx !== -1) { delete all[idx].oor_since; saveOpenLpPositions(all) }
          }
        }

        // ── 3. Net PnL stop-loss (price move + fees, after grace) ─────────────────
        // Only for real on-chain positions
        if (!isDrySim) {
          if (openedAt) {
            const ageMin = (now - new Date(openedAt).getTime()) / 1000 / 60
            if (ageMin >= netLossGraceMin) {
              const netPnl = computeNetPnlApprox(pos, onChainPos, activeBin, dlmmPool)
              if (netPnl != null) {
                pos.last_net_pnl_pct = Math.round(netPnl * 100) / 100
                // Persist for alert richness
                const all = getOpenLpPositions()
                const idx = all.findIndex((p: any) => p.id === pos.id)
                if (idx !== -1) { all[idx].last_net_pnl_pct = pos.last_net_pnl_pct; saveOpenLpPositions(all) }

                if (netPnl <= netLossThreshold) {
                  const reason = `net_pnl_sl_${netPnl.toFixed(1)}pct`
                  console.log(`[monitor] NET PNL SL EXIT → ${pos.symbol} (net ${netPnl.toFixed(1)}% <= ${netLossThreshold}% after ${Math.round(ageMin)}m grace)`)
                  const ok = await closePosition(pos.id, reason).catch(() => false)
                  if (ok) stats.closed++
                  continue
                }
              }
            }
          }
        }

        // ── 4. Hard max duration safety cap (1h for fresh memes) ───────────────────
        if (openedAt) {
          const hoursOpen = (now - new Date(openedAt).getTime()) / 1000 / 3600
          if (hoursOpen >= maxDurationH) {
            const reason = `max_duration_${hoursOpen.toFixed(1)}h`
            console.log(`[monitor] MAX DURATION EXIT → ${pos.symbol} (${hoursOpen.toFixed(1)}h / ${maxDurationH}h) — 1h fresh meme safety`)
            const ok = await closePosition(pos.id, reason).catch(() => false)
            if (ok) stats.closed++
            continue
          }
        }

        // Tick heartbeat for open positions (useful in dry-run logs)
        // For dry sim rows, netPnl will be n/a and OOR=false (on-chain skipped)
        if (feeTvl4hAvg != null || pos.last_net_pnl_pct != null) {
          console.log(
            `[monitor] ${pos.symbol} tick — 4hFeeTvlAvg=${feeTvl4hAvg?.toFixed(2) ?? 'n/a'}% ` +
            `netPnl=${pos.last_net_pnl_pct?.toFixed(1) ?? 'n/a'}% ` +
            `OOR=${isOOR ? 'yes' : 'no'}`
          )
        }
      } catch (e) {
        console.warn(`[monitor] LP exit check failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
      }
    }
  }

  return stats
}

// ── Helpers for the 4-rule exit engine ──────────────────────────────────────────

/**
 * Rough net PnL approximation for LP exit decisions during dry-run observation.
 * This is intentionally heuristic (active bin price + crude side valuation + pending fees).
 * It is NOT a full on-chain position valuation (token amounts × prices + all claimed + unclaimed fees).
 * Good enough to start collecting data on the -30% rule; can be improved later with better valuation.
 */
function computeNetPnlApprox(
  pos: any,
  onChainPos: any,
  activeBin: any,
  dlmmPool: any,
): number | null {
  try {
    const solDeposited = Number(pos.sol_deposited ?? 0)
    if (!solDeposited || solDeposited <= 0) return null

    const pd = onChainPos.positionData || {}
    const priceSolPerToken = getDecimalAdjustedPrice(dlmmPool, activeBin) || 0
    if (!priceSolPerToken || priceSolPerToken <= 0) return null

    const totalX = toNumber(pd.totalXAmount)
    const totalY = toNumber(pd.totalYAmount)

    const xPub = dlmmPool.tokenX?.publicKey?.toBase58?.() ?? ''
    const isXSol = xPub === 'So11111111111111111111111111111111111111112'
    const solSide = isXSol ? totalX : totalY
    const tokenSide = isXSol ? totalY : totalX

    const solValueOfTokens = tokenSide * priceSolPerToken
    const currentLiqValueSol = (solSide / 1e9) + solValueOfTokens

    const feeX = toNumber(pd.feeX ?? pd.fee_x)
    const feeY = toNumber(pd.feeY ?? pd.fee_y)
    const pendingFeeSolApprox = ((feeX + feeY) * priceSolPerToken) / 1e9

    const netSol = currentLiqValueSol + pendingFeeSolApprox - solDeposited
    return (netSol / solDeposited) * 100
  } catch {
    return null
  }
}

function toNumber(v: any): number {
  if (!v) return 0
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber()
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

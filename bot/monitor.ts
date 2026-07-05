import { getBotState } from '@/lib/botState'
import axios from 'axios'
import { getOpenLpPositions, saveOpenLpPositions, type OpenLpPosition, applyMonitorUpdates } from '@/lib/local-state'
import { closePosition } from '@/bot/executor/close'
import { claimFeesForPosition } from '@/bot/executor/close'
import { resolveSolPriceUsd } from '@/lib/sol-price'
import { getConnection, getWallet } from '@/lib/solana'
import {
  getDLMM,
  getDecimalAdjustedPrice,
  getClaimableFeesUsd,
  getInitializePositionAccounts,
} from '@/bot/executor/utils'
import { sendAlert } from '@/bot/alerter'
import { tryCloseEmptyPosition } from '@/bot/executor/open'
import {
  getCurrentPoolFeeTvl24h,
  getFeesActiveTvl24hPct,
  getFeesChange24h,
  getTvlChange24h,
}

// Module-level cache for dry-sim token prices (DexScreener) to avoid hammering external APIs
// on every 60s tick for multiple positions. TTL 60s as per audit.
const priceCache = new Map<string, { price: number; fetchedAt: number }>()
const PRICE_CACHE_TTL_MS = 60_000
  getTotalLps,
} from '@/bot/scanner/pool-fetcher'
import { PublicKey, Keypair, Transaction } from '@solana/web3.js'
import { ComputeBudgetProgram } from '@solana/web3.js'
import { sendLegacyTx } from '@/lib/solana-tx'
import BN from 'bn.js'
import {
  getPendingScaffolds,
  removePendingScaffold,
} from '@/bot/executor/persistence'
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
 * LP exit rules (see strategy-config + .env):
 * 1. Fee/TVL yield collapse: rolling 4h avg of pool 24h Fee/TVL < LP_FEE_TVL_EXIT_THRESHOLD
 * 2. Prolonged out-of-range: OOR for >= LP_OOR_EXIT_MINUTES
 * 3. Net PnL stop-loss after grace
 * 4. Hard max duration (1h safety)
 *
 * Additional activity signals (from the entry filters) are logged every tick:
 *   fees/active_24h yield proxy, fees_change_24h, tvl_change_24h, lps.
 * You can extend exits here (e.g. if fees_change_24h goes negative or yield collapses below 0.3%).
 *
 * Claim cadence (per original criteria): CLAIM fees every 30 min minimum while position is open.
 * Current implementation claims on close; monitor now surfaces "time for claim" recommendations.
 *
 * Dry-run simulation rows supported for full open+close testing.
 */

let tickCount = 0
const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1000
const LP_MONITOR_ENABLED = process.env.LP_MONITOR_ENABLED !== 'false'

// Per-position exit overrides are not used in the current 4-rule global model.
// Left as comment for future if per-position config is re-introduced.

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
  if (botState.enabled === false) {
    console.log('[lp-monitor] botState.enabled=false — skipping tick')
    return stats
  }

  tickCount++
  if (tickCount % 10 === 0) {
    console.log(`[lp-monitor] tick #${tickCount}`)
  }

  // Stranded sells are now on independent schedule in worker.ts to avoid blocking monitor tick
  await retryStrandedPositionRents().catch(err => console.error('[monitor] stranded position rents failed:', err))

  if (!LP_MONITOR_ENABLED) {
    console.log('[lp-monitor] disabled')
    return stats
  }

  // === LP exit rules (4-rule ultra-minimal model) ===
  let allPositions: OpenLpPosition[] = getOpenLpPositions()
  const positions: OpenLpPosition[] = allPositions.filter((p: OpenLpPosition) => ['open', 'active'].includes(p.status))
  stats.checked = positions.length

  if (positions.length > 0) {
    const wallet = getWallet()
    const connection = getConnection()
    const now = Date.now()

    // Resolved once per tick only if dry-sim rows with fees are present (avoids fetch for normal runs)
    let drySimSolPriceUsd: number | null = null

    let positionsMutated = false
    const monitorPatches: Array<{ id: string; patch: Partial<OpenLpPosition> }> = []

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
        let currentFeeTvl: number | null = null
        try {
          currentFeeTvl = await getCurrentPoolFeeTvl24h(pos.pool_address)
          if (currentFeeTvl != null && Number.isFinite(currentFeeTvl)) {
            let samples: Array<{ ts: number; fee_tvl_24h: number }> = Array.isArray(pos.fee_tvl_samples) ? pos.fee_tvl_samples : []
            samples.push({ ts: now, fee_tvl_24h: currentFeeTvl })

            // Cap raw array at 500 before pruning (prevent blowup from restarts/clock skew)
            if (samples.length > 500) {
              samples = samples.slice(-500)
            }

            // Prune to window + upper clock-skew bound
            const windowMs = sampleWindowH * 3600 * 1000
            const pruned = samples.filter((s) => s.ts <= now + 60_000 && now - s.ts <= windowMs)

            if (pruned.length > 0) {
              const avg = pruned.reduce((sum, s) => sum + s.fee_tvl_24h, 0) / pruned.length
              feeTvl4hAvg = Math.round(avg * 100) / 100
              pos.fee_tvl_samples = pruned
              pos.last_fee_tvl_4h_avg = feeTvl4hAvg
            } else {
              pos.fee_tvl_samples = pruned
            }

            monitorPatches.push({
              id: pos.id,
              patch: { fee_tvl_samples: pos.fee_tvl_samples, last_fee_tvl_4h_avg: pos.last_fee_tvl_4h_avg }
            })
            positionsMutated = true
          }
        } catch (e) {
          // Non-fatal — we still evaluate other rules
          console.warn(`[monitor] Fee/TVL sample failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
        }

        // Decouple min sample requirement from wall clock: on restart or skipped ticks, pruned list can shrink.
        // Use position age to relax the gate for positions that have had time to accumulate data.
        const positionAgeH = openedAt ? (now - new Date(openedAt).getTime()) / 3600000 : 0
        const minSamplesRequired = positionAgeH > 1 ? 5 : 10
        if (feeTvl4hAvg != null && feeTvl4hAvg < feeTvlThreshold && (pos.fee_tvl_samples?.length ?? 0) >= minSamplesRequired) {
          // Require >=10 samples (~10 min) for young positions; relax to 5 for older ones.
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
              let currentPrice: number | null = null
              const cached = priceCache.get(mintForPrice)
              const nowTs = Date.now()
              if (cached && (nowTs - cached.fetchedAt < PRICE_CACHE_TTL_MS)) {
                currentPrice = cached.price
              } else {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintForPrice}`, { timeout: 5000 })
                const pair = res.data?.pairs?.[0]
                currentPrice = pair?.priceUsd ? parseFloat(pair.priceUsd) : null
                if (currentPrice) {
                  priceCache.set(mintForPrice, { price: currentPrice, fetchedAt: nowTs })
                }
              }
              if (currentPrice) {
                let roughPnl = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100
                const claimable = getClaimableFeesUsd(pos) ?? 0
                if (claimable > 0 && pos.sol_deposited > 0) {
                  // Use live SOL price (via shared resolver) instead of hardcoded 150.
                  // Fees contribution is usually tiny for dry sims but now accurate when present.
                  if (drySimSolPriceUsd == null) {
                    drySimSolPriceUsd = await resolveSolPriceUsd().catch(async () => {
                      // Secondary fallback: CoinGecko (avoids stale 170)
                      try {
                        const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 3000 })
                        const price = r.data?.solana?.usd
                        if (price) return price
                      } catch {}
                      return null
                    })
                    if (drySimSolPriceUsd === null) {
                      console.warn(`[monitor] no SOL price available for dry-sim PnL of ${pos.symbol} — skipping fee contribution`)
                    } else if (drySimSolPriceUsd < 100 || drySimSolPriceUsd > 300) {
                      console.warn(`[monitor] using unusual SOL price ${drySimSolPriceUsd} for dry-sim PnL of ${pos.symbol}`)
                    }
                  }
                  if (drySimSolPriceUsd != null) {
                    roughPnl += (claimable / (pos.sol_deposited * drySimSolPriceUsd)) * 100
                  }
                }
                pos.last_net_pnl_pct = Math.round(roughPnl * 100) / 100
                monitorPatches.push({ id: pos.id, patch: { last_net_pnl_pct: pos.last_net_pnl_pct } })
                positionsMutated = true
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
              // Immediate targeted write for OOR timer (crash safety)
              await applyMonitorUpdates([{ id: pos.id, patch: { oor_since: pos.oor_since } }])
              positionsMutated = true
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
            await applyMonitorUpdates([{ id: pos.id, patch: { oor_since: null as any } }])
            positionsMutated = true
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
                monitorPatches.push({ id: pos.id, patch: { last_net_pnl_pct: pos.last_net_pnl_pct } })
                positionsMutated = true

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
            console.log(`[monitor] MAX DURATION EXIT → ${pos.symbol} (${hoursOpen.toFixed(1)}h / ${maxDurationH}h) — 1h safety`)
            const ok = await closePosition(pos.id, reason).catch(() => false)
            if (ok) stats.closed++
            continue
          }
        }

        // Claim cadence reminder (criteria: CLAIM every 30 min minimum)
        const lastClaim = pos.last_claim_at ? new Date(pos.last_claim_at).getTime() : (openedAt ? new Date(openedAt).getTime() : now)
        const minutesSinceClaim = (now - lastClaim) / 1000 / 60
        const lastAttempt = pos.last_claim_attempt_at ? new Date(pos.last_claim_attempt_at).getTime() : 0
        const minutesSinceAttempt = lastAttempt ? (now - lastAttempt) / 1000 / 60 : 999
        if (minutesSinceClaim >= 30 && minutesSinceAttempt >= 10) {
          console.log(`[monitor] ${pos.symbol} — time for fee claim (≥30m) — attempting auto-claim`)
          claimFeesForPosition(pos.id).then((claimed) => {
            if (claimed) console.log(`[monitor] auto-claimed fees for ${pos.symbol}`)
          }).catch(() => {})
        }

        // Tick heartbeat for open positions (useful in dry-run logs)
        // For dry sim rows, netPnl will be n/a and OOR=false (on-chain skipped)
        // Also surface the activity signals (24h fees/active yield proxy + changes) for the position's pool.
        if (feeTvl4hAvg != null || pos.last_net_pnl_pct != null) {
          // Use the just-fetched current 24h Fee/TVL (or the rolling 4h avg) for the yield proxy.
          // Previously the log was calling the getters with dummy {} objects, causing 0.00.
          const yield24hProxy = currentFeeTvl ?? feeTvl4hAvg ?? 0;

          // Compute a simple recent change from the fee_tvl samples we just maintained
          // (fee_tvl change acts as a combined proxy for fees/tvl movement signals).
          // We no longer emit two identical values (was: tvlChg24h = feesChg24h).
          let feeTvlChg24h = 0;
          const prunedSamples: Array<{ ts: number; fee_tvl_24h: number }> = pos.fee_tvl_samples || [];
          if (prunedSamples.length >= 2) {
            const last = prunedSamples[prunedSamples.length - 1].fee_tvl_24h;
            const prev = prunedSamples[prunedSamples.length - 2].fee_tvl_24h;
            if (prev > 0) {
              const pct = ((last - prev) / prev) * 100;
              feeTvlChg24h = Math.round(pct * 100) / 100;
            }
          }

          console.log(
            `[monitor] ${pos.symbol} tick — 4hFeeTvlAvg=${feeTvl4hAvg?.toFixed(2) ?? 'n/a'}% ` +
            `netPnl=${pos.last_net_pnl_pct?.toFixed(1) ?? 'n/a'}% ` +
            `OOR=${isOOR ? 'yes' : 'no'} ` +
            `yield24hProxy≈${yield24hProxy.toFixed(2)}% ` +
            `feeTvlChg24h≈${feeTvlChg24h.toFixed(2)}`
          )
        }
      } catch (e) {
        console.warn(`[monitor] LP exit check failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
      }
    }

    // Apply via reload+merge (prevents monitor snapshot clobbering concurrent scanner opens / other writers)
    if (positionsMutated) {
      await applyMonitorUpdates(monitorPatches)
    }
  }

  return stats
}

// ── Helpers for the 4-rule exit engine ──────────────────────────────────────────

/**
 * Rough net PnL approximation for LP exit decisions.
 * Heuristic only: uses *active bin price* (or conservative edge bin price for wide OOR).
 * For wide ranges that are partially OOR this can over/under-estimate value significantly.
 * When dist >0.6 from center, uses worst-case edge price instead of skipping SL.
 * It is intentionally approximate — NOT for precise accounting.
 * Full bin-by-bin valuation would be more accurate but heavier.
 */
function computeNetPnlApprox(
  pos: OpenLpPosition,
  onChainPos: any,
  activeBin: any,
  dlmmPool: any,
): number | null {
  try {
    const solDeposited = Number(pos.sol_deposited ?? 0)
    if (!solDeposited || solDeposited <= 0) {
      console.warn(`[monitor] computeNetPnlApprox: sol_deposited missing or 0 for ${pos.symbol} — returning null`)
      return null
    }

    const pd = onChainPos.positionData || {}
    const priceSolPerToken = getDecimalAdjustedPrice(dlmmPool, activeBin) || 0
    if (!priceSolPerToken || priceSolPerToken <= 0) return null

    const totalX = toNumber(pd.totalXAmount)
    const totalY = toNumber(pd.totalYAmount)

    const xPub = dlmmPool.tokenX?.publicKey?.toBase58?.() ?? ''
    const isXSol = xPub === 'So11111111111111111111111111111111111111112'
    const solSideLamports = isXSol ? totalX : totalY
    const tokenSideLamports = isXSol ? totalY : totalX

    // Convert token lamports to whole units using the token's decimals (critical — priceSolPerToken is per whole token)
    const tokenDecimals = (isXSol ? dlmmPool.tokenY?.decimals : dlmmPool.tokenX?.decimals) ?? 6;
    const tokenSideWhole = tokenSideLamports / Math.pow(10, tokenDecimals);
    const solValueOfTokens = tokenSideWhole * priceSolPerToken;
    const currentLiqValueSol = (solSideLamports / 1e9) + solValueOfTokens;

    const feeX = toNumber(pd.feeX ?? pd.fee_x)
    const feeY = toNumber(pd.feeY ?? pd.fee_y)
    // Mirror isXSol for fees: fee on SOL side vs token side (fixes incorrect pending SOL fee value when SOL is tokenY)
    const feeSolLamports = isXSol ? feeX : feeY
    const feeTokenLamports = isXSol ? feeY : feeX
    const feeTokenWhole = feeTokenLamports / Math.pow(10, tokenDecimals)
    const pendingFeeSolApprox = (feeSolLamports / 1e9) + (feeTokenWhole * priceSolPerToken)

    const netSol = currentLiqValueSol + pendingFeeSolApprox - solDeposited
    const netPct = (netSol / solDeposited) * 100

    // Bias correction for wide ranges: if active bin far from range center, the active price is a bad proxy for whole position value.
    // Use conservative worst-case estimate using edge bin prices instead of skipping (OOR and other rules still apply).
    // Lower bin price used for token-heavy positions (undervalues the token leg).
    // This ensures PnL SL can still fire for distressed wide-range positions.
    const { lowerBinId, upperBinId } = onChainPos.positionData || {}
    if (lowerBinId != null && upperBinId != null) {
      const rangeMidBin = (lowerBinId + upperBinId) / 2
      const rangeHalf = Math.max(1, (upperBinId - lowerBinId) / 2)
      const binDistFraction = Math.abs(activeBin.binId - rangeMidBin) / rangeHalf
      if (binDistFraction > 0.6) {
        const binStep = (dlmmPool.lbPair && dlmmPool.lbPair.binStep / 10000) || 0.01
        const priceAtLower = priceSolPerToken * Math.pow(1 + binStep, lowerBinId - activeBin.binId)
        const priceAtUpper = priceSolPerToken * Math.pow(1 + binStep, upperBinId - activeBin.binId)
        // Conservative (lowest) price for token valuation to make net look as bad as possible for SL decision
        const consPrice = Math.min(priceAtLower, priceAtUpper, priceSolPerToken)
        const solValueOfTokensCons = tokenSideWhole * consPrice
        const currentLiqValueSolCons = (solSideLamports / 1e9) + solValueOfTokensCons
        const pendingFeeSolApproxCons = (feeSolLamports / 1e9) + (feeTokenWhole * consPrice)
        const netSolCons = currentLiqValueSolCons + pendingFeeSolApproxCons - solDeposited
        const netPctCons = (netSolCons / solDeposited) * 100
        console.warn(`[monitor] computeNetPnlApprox: using conservative edge price for ${pos.symbol} (dist=${binDistFraction.toFixed(2)}) — netPct approx ${netPctCons.toFixed(1)}%`)
        return netPctCons
      }
    }

    return netPct
  } catch {
    return null
  }
}

function toNumber(v: any): number {
  if (!v) return 0
  // Safe path for BN (and similar) to avoid silent overflow on >2^53 values (large meme token amounts)
  if (BN.isBN(v) || (v && typeof v.toNumber === 'function')) {
    try {
      return v.toNumber()
    } catch {
      const s = typeof v.toString === 'function' ? v.toString(10) : String(v)
      const n = Number(s)
      return Number.isFinite(n) ? n : (parseFloat(s) || 0)
    }
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Background recovery for stranded position rent accounts (createAccount only, never fully opened).
 * These are persisted when a scaffold bundle succeeds but the open later aborts.
 * We attempt close using the saved bin range (or closePosition only if no range).
 */
export async function retryStrandedPositionRents() {
  const positions = getOpenLpPositions() as any[];
  const stranded = positions.filter((p: any) => p.status === 'stranded_rent' || (p.close_reason || '').includes('stranded_rent'));

  // Cleanup stale pending scaffolds (no matching stranded marker after 24h).
  // Prevents accumulation if process killed between persistPendingScaffold and persistStranded.
  try {
    const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const strandedPubs = new Set(stranded.map((s: any) => s.position_pubkey));
    const pendings = getPendingScaffolds();
    for (const p of pendings) {
      if (strandedPubs.has(p.pubkey)) continue;
      const age = now - new Date(p.createdAt).getTime();
      if (age > MAX_PENDING_AGE_MS) {
        removePendingScaffold(p.pubkey);
        console.log(`[monitor] cleaned stale pending scaffold (no marker, ${Math.round(age / 3600000)}h old): ${p.pubkey.slice(0, 8)}`);
      }
    }
  } catch (e) {
    console.warn('[monitor] pending scaffold cleanup failed:', e);
  }

  if (stranded.length === 0) return;

  console.log(`[monitor] checking ${stranded.length} stranded position rent accounts for reclaim...`);
  const wallet = getWallet();
  const connection = getConnection();

  for (const s of stranded) {
    if (!s.position_pubkey || !s.pool_address) continue;
    try {
      const dlmmPool = await (await getDLMM()).create(connection, new PublicKey(s.pool_address));
      const pub = new PublicKey(s.position_pubkey);
      const minB = (s.metadata && typeof s.metadata.min_bin_id === 'number') ? s.metadata.min_bin_id : undefined;
      const maxB = (s.metadata && typeof s.metadata.max_bin_id === 'number') ? s.metadata.max_bin_id : undefined;

      console.log(`[monitor] attempting reclaim for stranded rent ${s.position_pubkey.slice(0,8)} pool ${s.pool_address.slice(0,8)}`);

      // If we persisted the secret early (before createAccount), use it now to initialize the ghost.
      // This writes the Anchor discriminator so that closePosition can succeed.
      // Idempotency: check account data length first (initialized DLMM positions are >>100 bytes).
      try {
        const accountInfo = await connection.getAccountInfo(pub).catch(() => null);
        const isAlreadyInitialized = accountInfo && accountInfo.data && accountInfo.data.length >= 100;
        if (isAlreadyInitialized) {
          console.log(`[monitor] ${s.position_pubkey.slice(0,8)} already initialized — skipping init, proceeding to close`);
        } else {
          const pendings = getPendingScaffolds();
          const match = pendings.find((p: any) => p.pubkey === s.position_pubkey);
          if (match && Array.isArray(match.secret) && match.secret.length > 0) {
            const kp = Keypair.fromSecretKey(Uint8Array.from(match.secret));
            const lower = typeof minB === 'number' ? minB : 0;
            const width = (typeof maxB === 'number' && typeof minB === 'number') ? (maxB - minB) : 140;
            console.log(`[monitor] persisted secret found — initializing ${s.position_pubkey.slice(0,8)} lower=${lower} width=${width}`);

            const initIx = await dlmmPool.program.methods
              .initializePosition(lower, width)
              .accounts(
                getInitializePositionAccounts(dlmmPool, wallet.publicKey, pub, dlmmPool.pubkey)
              )
              .instruction();

            const initTx = new Transaction();
            initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
            initTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }));
            initTx.add(initIx);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            initTx.recentBlockhash = blockhash;
            initTx.feePayer = wallet.publicKey;

            const initSig = await sendLegacyTx(initTx, [wallet, kp], `[monitor-stray-init-${s.position_pubkey.slice(0,8)}]`);
            console.log(`[monitor] ghost initialized via persisted secret ✔ ${initSig}`);
            removePendingScaffold(s.position_pubkey);
          }
        }
      } catch (initErr: any) {
        console.warn(`[monitor] secret init attempt failed for ${s.position_pubkey.slice(0,8)} (will try close anyway): ${initErr?.message || initErr}`);
      }

      // Use the exported tryClose (it now supports optional bins and will prefer closePosition for uninit ghosts)
      const closeOk = await tryCloseEmptyPosition(dlmmPool, pub, wallet, minB, maxB, `[monitor-stranded-rent-${s.position_pubkey.slice(0,8)}]`, 200000);
      console.log(`[monitor] tryCloseEmptyPosition returned success=${closeOk} for ${s.position_pubkey.slice(0,8)}`);

      if (!closeOk) {
        sendAlert({
          type: 'warning',
          message: `⚠️ Monitor rent reclaim failed for ${s.position_pubkey} — will retry next tick`,
        }).catch(() => {});
      }

      // If we reached here without throwing, consider it done or remove the marker.
      // For safety, only remove if the account no longer exists or data is small.
      const info = await connection.getAccountInfo(pub).catch(() => null);
      if (!info || info.lamports === 0 || (info.data && info.data.length < 100)) {
        const all = getOpenLpPositions();
        const filtered = all.filter((p: any) => p.position_pubkey !== s.position_pubkey || p.status !== 'stranded_rent');
        saveOpenLpPositions(filtered);
        removePendingScaffold(s.position_pubkey);
        console.log(`[monitor] reclaimed/removed stranded rent marker for ${s.position_pubkey.slice(0,8)}`);
      }
    } catch (e) {
      console.warn(`[monitor] stranded rent reclaim attempt for ${s.position_pubkey.slice(0,8)} failed (will retry next tick): ${e}`);
    }
  }
}

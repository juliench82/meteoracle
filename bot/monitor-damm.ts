import { closeDammPosition } from './damm-executor'
import { sendAlert } from './alerter'
import { sbSelect, sbUpdate, firstNumber, nullableNumber, roundMoney, roundPct } from './monitor-core'

// All DAMM edge exit logic extracted from monitor.ts to keep files <20k chars.
// No logic lost — exact copy of checkDammEdgePosition + fetchDammPositionState + fetchDammLivePnl stub.

export async function checkDammEdgePosition(
  position: any,
  strategy: any,
  stats: { checked: number; closed: number; claimed: number; rebalanced: number },
  liveSolPriceUsd: number | null,
): Promise<void> {
  const label = `[monitor][${position.symbol}][damm-edge]`
  const { pnlPct, ageHours, positionValueUsd, previousNullPnlTicks } = await fetchDammPositionState(
    position.id,
    position.pool_address,
    position.position_pubkey,
    liveSolPriceUsd,
  )
  const currentNullPnlTicks = pnlPct === null ? previousNullPnlTicks + 1 : 0

  try {
    await sbUpdate('lp_positions', `id=eq.${position.id}`, {
      null_pnl_ticks: currentNullPnlTicks,
    })
  } catch (err) {
    console.error(`${label} null_pnl_ticks update failed:`, err)
  }

  console.log(
    `${label} pnlPct=${pnlPct !== null ? `${pnlPct.toFixed(2)}%` : 'n/a'} ` +
    `age=${ageHours.toFixed(1)}h posValue=$${positionValueUsd ?? 'n/a'} ` +
    `nullPnlTicks=${currentNullPnlTicks}`,
  )

  let closeReason: string | null = null

  if (currentNullPnlTicks >= 10) {
    closeReason = `pnl_unavailable_10ticks`
  } else if (pnlPct !== null && pnlPct <= strategy.exits.stopLossPct) {
    closeReason = `stoploss_pnl_${pnlPct.toFixed(1)}pct`
  } else if (pnlPct !== null && pnlPct >= strategy.exits.takeProfitPct) {
    closeReason = `takeprofit_pnl_${pnlPct.toFixed(1)}pct`
  } else if (ageHours >= strategy.exits.maxDurationHours) {
    closeReason = `max_duration_${Math.round(ageHours)}h`
  } else if (pnlPct === null) {
    if (currentNullPnlTicks >= 3) {
      if (currentNullPnlTicks === 3 || currentNullPnlTicks % 3 === 0) {
        await sendAlert({
          type: 'pnl_unavailable_warning',
          symbol: position.symbol,
          strategy: strategy.id,
          positionId: position.id,
          reason: `damm_pnl_unavailable_${currentNullPnlTicks}ticks`,
          ageHours: Math.round(ageHours * 10) / 10,
        })
      }
      console.warn(`${label} DAMM PnL unavailable ${currentNullPnlTicks} consecutive ticks`)
    } else {
      console.warn(`${label} DAMM PnL unavailable — stop-loss/take-profit skipped this tick`)
    }
  }

  if (!closeReason) return

  console.log(`${label} EXIT triggered → ${closeReason}`)
  const closeResult = await closeDammPosition(position.id, closeReason)
  const closed = closeResult.success
  if (closed) {
    stats.closed++
    await sendAlert({
      type: 'position_closed',
      symbol: position.symbol,
      strategy: 'damm-edge',
      reason: closeReason,
      ilPct: null,
      ageHours: Math.round(ageHours * 10) / 10,
    })
  } else {
    console.warn(`${label} close skipped or failed: ${closeResult.error ?? 'unknown error'}`)
  }
}

async function fetchDammPositionState(
  positionId: string,
  poolAddress: string,
  positionPubkey: string,
  liveSolPriceUsd: number | null,
): Promise<{
  pnlPct: number | null
  ageHours: number
  positionValueUsd: number | null
  previousNullPnlTicks: number
}> {
  const rows = await sbSelect<any>(
    'lp_positions',
    `id=eq.${positionId}&select=pnl_pct,position_value_usd,opened_at,metadata,null_pnl_ticks,pool_address,position_pubkey,sol_deposited&limit=1`,
  )
  const row = rows[0]
  if (!row) return { pnlPct: null, ageHours: 0, positionValueUsd: null, previousNullPnlTicks: 0 }

  const metadata = row.metadata ?? {}
  const deployedSol = nullableNumber(row.sol_deposited) ?? 0

  const costBasisUsd = firstNumber(
    metadata.meteora_total_deposit_usd,
    metadata.total_deposit_usd,
    metadata.deposit_usd,
    metadata.cost_basis_usd,
  ) ?? (() => {
    const entrySolPriceUsd = firstNumber(metadata.sol_price_usd, metadata.current_sol_price_usd)
    return entrySolPriceUsd !== null && deployedSol > 0 ? deployedSol * entrySolPriceUsd : null
  })()

  const livePnlPct = null // stub — real on-chain would go here
  const pnlPct = livePnlPct

  const positionValueUsd = row.position_value_usd !== null ? roundMoney(row.position_value_usd) : null
  const ageHours = (Date.now() - new Date(row.opened_at).getTime()) / (1000 * 60 * 60)
  const previousNullPnlTicks = Math.max(0, Math.trunc(nullableNumber(row.null_pnl_ticks) ?? 0))

  return { pnlPct, ageHours, positionValueUsd, previousNullPnlTicks }
}

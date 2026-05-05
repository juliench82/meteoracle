import axios from 'axios'
import { summarizeError } from '@/lib/logging'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

type AlertPayload =
  | {
      type: 'position_opened'
      symbol: string
      strategy: string
      solDeposited: number
      entryPrice: number
      positionId: string
      takeProfitPct?: number
      stopLossPct?: number
      volume24h?: number
      entryPriceUsd?: number
      entryPriceSol?: number
      meteoracleScore?: number
      rugcheckScore?: number | string
      poolAddress?: string
      mint?: string
    }
  | {
      type: 'position_closed'
      symbol: string
      strategy: string
      reason: string
      claimableFeesUsd?: number
      ilPct: number
      ageHours: number
      netPnlSol?: number
    }
  | {
      type: 'position_oor'
      symbol: string
      strategy: string
      currentPrice: number
      binRangeLower: number
      binRangeUpper: number
      oorExitMinutes: number
    }
  | {
      type: 'position_fee_yield_extended'
      symbol: string
      strategy: string
      totalFees: string
      feeYieldPct: string
      avgDailyYield: string | null
      extensions: number
      extraHours?: number
      effectiveMaxDurationHours: number
      positionId: string
    }
  | { type: 'candidate_found'; symbol: string; strategy: string; score: number; mcUsd: number; volume24h: number; bondingCurvePct?: number }
  | { type: 'position_rebalanced'; symbol: string; strategy: string; reason: string; oldPositionId: string; newPositionId: string; feeTvl24hPct?: number; volume24hUsd?: number; liquidityUsd?: number }
  | { type: 'orphan_detected'; symbol: string; positionPubKey: string; poolAddress: string; mint?: string; positionType?: string }
  | { type: 'pre_grad_pool_created'; symbol: string; mint: string; pool: string; sol: number }
  | { type: 'pre_grad_create_failed'; mint: string; error: string }
  | { type: 'pre_grad_opened'; symbol: string; positionId: string; poolAddress: string; bondingCurvePct: number }
  | {
      type: 'pre_grad_closed'
      symbol: string
      positionId: string
      ageMin: number
      reason: string
      claimableFeesUsd?: number
      positionValueUsd?: number
      /** Realized PnL from Meteora API, available after zap-out confirms. */
      realizedPnlUsd?: number
    }
  | { type: 'pre_grad_graduated'; symbol: string; finalFees?: number; positionId?: string; bondingCurvePct?: number }
  | { type: 'low_balance_warning'; currentSol: number; minSol: number }
  | { type: 'high_il_warning'; symbol: string; ilPct: number; claimableFeesUsd?: number; netPnlSol: number }
  | { type: 'pnl_unavailable_warning'; symbol: string; strategy: string; positionId: string; reason: string; ageHours: number }
  | { type: 'error'; message: string }

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const message = formatMessage(payload)
  await sendTelegram(message)
}

function strategyBadge(strategy: string): string {
  const s = strategy.toLowerCase()
  if (s.includes('damm') || s.includes('pre_grad') || s.includes('pre-grad')) {
    return '🌱 DAMM v2'
  }
  return '📊 DLMM'
}

function formatUsdPrice(value: number | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return 'N/A'
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
  return `$${value.toPrecision(6)}`
}

function formatScore(score: number | undefined): string {
  if (score == null || !Number.isFinite(score)) return 'N/A'
  return `${Math.round(score)}/100`
}

function formatMessage(payload: AlertPayload): string {
  switch (payload.type) {
    case 'position_opened': {
      const dexUrl = `https://dexscreener.com/solana/${payload.poolAddress || payload.mint || ''}`
      const entryUsd = payload.entryPriceUsd ?? payload.entryPrice
      const entrySol = payload.entryPriceSol ?? ''
      const entrySolPart = entrySol ? ` | ${entrySol} SOL` : ''
      return [
        `🟢 *BUY* ${payload.symbol}`,
        `💰 Deployed: ${payload.solDeposited} SOL`,
        `🎯 Meteoracle Score: *${formatScore(payload.meteoracleScore)}*`,
        `💵 Entry Price: ${formatUsdPrice(entryUsd)}${entrySolPart}`,
        `🧠 Strategy: ${payload.strategy}`,
        `📈 ${dexUrl}`,
      ].join('\n')
    }

    case 'position_closed': {
      const netPnl = payload.netPnlSol ?? 0
      const netSign = netPnl >= 0 ? '+' : ''
      return [
        `🔴 *SELL* ${payload.symbol}`,
        `Reason: ${payload.reason}`,
        `Claimable Fees: *${payload.claimableFeesUsd != null ? `$${payload.claimableFeesUsd.toFixed(2)}` : 'N/A'}*`,
        `IL: ${payload.ilPct.toFixed(2)}% | Net PNL: ${netSign}${netPnl} SOL`,
        `Held for: ${payload.ageHours}h`,
        `Strategy: ${payload.strategy}`,
      ].join('\n')
    }

    case 'position_oor':
      return [
        `⚠️ *Out of Range*`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Current price: ${payload.currentPrice.toFixed(9)} SOL`,
        `Range: ${payload.binRangeLower.toFixed(9)} - ${payload.binRangeUpper.toFixed(9)} SOL`,
        `Will close in: ${payload.oorExitMinutes}min if not recovered`,
      ].join('\n')

    case 'position_fee_yield_extended': {
      const dailyLine = payload.avgDailyYield !== null
        ? `Daily Yield: ${payload.avgDailyYield}%`
        : `Daily Yield: N/A (< 24h old)`
      return [
        `🚀 *FEE-YIELD EXTENDED* ${payload.symbol}`,
        `Total Fees: *${payload.totalFees} SOL* (${payload.feeYieldPct}% of deployed)`,
        dailyLine,
        `Extensions: ${payload.extensions} | +${payload.extraHours ?? '?'}h added`,
        `New Max Duration: ${payload.effectiveMaxDurationHours}h`,
      ].join('\n')
    }

    // candidate_found intentionally produces no Telegram message (noise reduction)
    case 'candidate_found':
      return ''

    case 'position_rebalanced':
      return [
        `🔄 *REBALANCED* ${payload.symbol}`,
        `Reason: ${payload.reason}`,
        `Strategy: ${payload.strategy}`,
        `Old: \`${payload.oldPositionId}\``,
        `New: \`${payload.newPositionId}\``,
        payload.feeTvl24hPct != null ? `24h Fees/TVL: ${payload.feeTvl24hPct.toFixed(2)}%` : null,
        payload.volume24hUsd != null ? `24h Volume: $${payload.volume24hUsd.toFixed(0)}` : null,
        payload.liquidityUsd != null ? `Liquidity: $${payload.liquidityUsd.toFixed(0)}` : null,
      ].filter(Boolean).join('\n')

    case 'orphan_detected':
      return [
        `👻 *Orphaned Position Detected*`,
        `Symbol: \`${payload.symbol}\``,
        payload.positionType ? `Type: \`${payload.positionType}\`` : null,
        payload.mint ? `Mint: \`${payload.mint}\`` : null,
        `Position: \`${payload.positionPubKey}\``,
        `Pool: \`${payload.poolAddress}\``,
        `_On-chain in Meteora but missing from Supabase cache — inserted automatically_`,
      ].filter(Boolean).join('\n')

    case 'pre_grad_pool_created':
      return [
        `🌱 *Pre-Grad DAMM v2 Pool Created*`,
        `Token: \`${payload.symbol}\``,
        `Mint: \`${payload.mint}\``,
        `Pool: \`${payload.pool}\``,
        `Deployed: ${payload.sol.toFixed(4)} SOL`,
      ].join('\n')

    case 'pre_grad_create_failed':
      return [
        `❌ *Pre-Grad Pool Create Failed*`,
        `Mint: \`${payload.mint}\``,
        `Error: ${payload.error}`,
      ].join('\n')

    case 'pre_grad_opened':
      return [
        `🌱 *Pre-Grad Position Opened*`,
        `Token: \`${payload.symbol}\``,
        `ID: \`${payload.positionId}\``,
        `Pool: \`${payload.poolAddress}\``,
        `Curve: ${payload.bondingCurvePct.toFixed(1)}% ${bondingCurveEmoji(payload.bondingCurvePct)}`,
      ].join('\n')

    case 'pre_grad_closed': {
      const valueLine      = payload.positionValueUsd  != null
        ? `Value: *$${payload.positionValueUsd.toFixed(2)}*`
        : null
      const pnlSign        = (payload.realizedPnlUsd ?? 0) >= 0 ? '+' : ''
      const pnlLine        = payload.realizedPnlUsd    != null
        ? `Realized PnL: *${pnlSign}$${payload.realizedPnlUsd.toFixed(2)}*`
        : null
      const feesLine       = payload.claimableFeesUsd  != null
        ? `Claimable Fees: *$${payload.claimableFeesUsd.toFixed(2)}*`
        : null
      return [
        `🌿 *Pre-Grad Position Closed*`,
        `Token: \`${payload.symbol}\``,
        `ID: \`${payload.positionId}\``,
        `Reason: ${payload.reason}`,
        `Age: ${payload.ageMin}min`,
        valueLine,
        pnlLine,
        feesLine,
      ].filter(Boolean).join('\n')
    }

    case 'pre_grad_graduated':
      return [
        `🎉 *PRE-GRAD GRADUATED* ${payload.symbol}`,
        `Moved to Raydium successfully.`,
        `Final Fees: ${payload.finalFees ?? 0} SOL`,
      ].join('\n')

    case 'low_balance_warning':
      return [
        `⚠️ *LOW BALANCE WARNING*`,
        `Current SOL: ${payload.currentSol}`,
        `Recommended minimum: ${payload.minSol}`,
        `Please top up your wallet.`,
      ].join('\n')

    case 'high_il_warning':
      return [
        `📉 *HIGH IL WARNING* ${payload.symbol}`,
        `Current IL: ${payload.ilPct.toFixed(2)}%`,
        `Claimable Fees: ${payload.claimableFeesUsd != null ? `$${payload.claimableFeesUsd.toFixed(2)}` : 'N/A'}`,
        `Net PNL: ${payload.netPnlSol} SOL`,
        `Consider closing manually if IL keeps growing.`,
      ].join('\n')

    case 'pnl_unavailable_warning':
      return [
        `⚠️ *PnL Feed Unavailable* ${payload.symbol}`,
        `Strategy: ${payload.strategy}`,
        `Position: \`${payload.positionId}\``,
        `Reason: ${payload.reason}`,
        `Age: ${payload.ageHours}h`,
        `Stop-loss/take-profit protection is degraded.`,
      ].join('\n')

    case 'error':
      return `❌ *Bot Error*\n${payload.message}`

    default:
      return `🤖 Meteoracle event`
  }
}

function bondingCurveEmoji(pct: number): string {
  if (pct >= 100) return '✅ graduated'
  if (pct >= 95)  return '🔴 graduating'
  if (pct >= 70)  return '🟡 hot'
  if (pct >= 40)  return '🟢 filling'
  return '⚪ early'
}

async function sendTelegram(text: string): Promise<void> {
  // candidate_found returns empty string — skip silently
  if (!text) return

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[alerter] Telegram not configured — alert skipped')
    return
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      },
      { timeout: 5_000 }
    )
  } catch (err) {
    console.error(`[alerter] Telegram send failed: ${summarizeError(err)}`)
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

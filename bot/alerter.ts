import axios from 'axios'

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
      rugcheckScore?: number | string
      poolAddress?: string
      mint?: string
    }
  | {
      type: 'position_closed'
      symbol: string
      strategy: string
      reason: string
      feesEarnedSol: number
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
  | { type: 'orphan_detected'; symbol: string; positionPubKey: string; poolAddress: string }
  | { type: 'cooldown_skip'; symbol: string; strategy: string; cooldownHours: number }
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
    }
  | { type: 'pre_grad_graduated'; symbol: string; finalFees?: number; positionId?: string; bondingCurvePct?: number }
  | { type: 'low_balance_warning'; currentSol: number; minSol: number }
  | { type: 'high_il_warning'; symbol: string; ilPct: number; feesEarnedSol: number; netPnlSol: number }
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

function formatMessage(payload: AlertPayload): string {
  switch (payload.type) {
    case 'position_opened': {
      const dexUrl = `https://dexscreener.com/solana/${payload.poolAddress || payload.mint || ''}`
      const tp = payload.takeProfitPct ?? '?'
      const sl = payload.stopLossPct ?? '?'
      const vol = payload.volume24h?.toLocaleString() ?? 'N/A'
      const entryUsd = payload.entryPriceUsd ?? payload.entryPrice
      const entrySol = payload.entryPriceSol ?? ''
      const entrySolPart = entrySol ? ` (${entrySol} SOL)` : ''
      return [
        `🟢 *BUY* ${payload.symbol}`,
        `💰 ${payload.solDeposited} SOL | TP +${tp}% | SL ${sl}%`,
        `📊 Vol: $${vol} | Entry: $${entryUsd}${entrySolPart}`,
        `🦍 Strategy: ${payload.strategy} | Rug: ${payload.rugcheckScore ?? 'N/A'}`,
        `📈 ${dexUrl}`,
      ].join('\n')
    }

    case 'position_closed': {
      const netPnl = payload.netPnlSol ?? 0
      const netSign = netPnl >= 0 ? '+' : ''
      return [
        `🔴 *SELL* ${payload.symbol}`,
        `Reason: ${payload.reason}`,
        `Fees Earned: *${payload.feesEarnedSol} SOL*`,
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
        `Current price: $${payload.currentPrice.toFixed(8)}`,
        `Range: $${payload.binRangeLower.toFixed(8)} – $${payload.binRangeUpper.toFixed(8)}`,
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

    case 'orphan_detected':
      return [
        `👻 *Orphaned Position Detected*`,
        `Symbol: \`${payload.symbol}\``,
        `Position: \`${payload.positionPubKey}\``,
        `Pool: \`${payload.poolAddress}\``,
        `_On-chain but missing from DB — marked orphaned_`,
      ].join('\n')

    case 'cooldown_skip':
      return [
        `⏳ *Cooldown Skip*`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Skipped — closed within last ${payload.cooldownHours}h`,
      ].join('\n')

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
      const valueLine = payload.positionValueUsd != null
        ? `Value: *$${payload.positionValueUsd.toFixed(2)}*`
        : null
      const feesLine = payload.claimableFeesUsd != null
        ? `Claimable Fees: *$${payload.claimableFeesUsd.toFixed(2)}*`
        : null
      return [
        `🌿 *Pre-Grad Position Closed*`,
        `Token: \`${payload.symbol}\``,
        `ID: \`${payload.positionId}\``,
        `Reason: ${payload.reason}`,
        `Age: ${payload.ageMin}min`,
        valueLine,
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
        `Fees Earned: ${payload.feesEarnedSol} SOL`,
        `Net PNL: ${payload.netPnlSol} SOL`,
        `Consider closing manually if IL keeps growing.`,
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
    console.log('[alerter] Telegram not configured — message:', text)
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
    console.error('[alerter] Telegram send failed:', err)
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

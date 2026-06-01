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
      rugcheckUrl?: string
      holderCount?: number
      topHolderPct?: number
      poolAddress?: string
      mint?: string
    }
  | {
      type: 'position_closed'
      symbol: string
      strategy: string
      reason: string
      claimableFeesUsd?: number
      ilPct: number | null
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
  | { type: 'candidate_found'; symbol: string; strategy: string; score: number; mcUsd: number; volume24h: number; bondingCurvePct?: number }
  | { type: 'pnl_unavailable_warning'; symbol: string; strategy: string; positionId: string; reason: string; ageHours: number }
  | {
      type: 'moonboy_opened'
      symbol: string
      mint: string
      buyUsd: number
      solSpent: number
      entryPriceUsd: number
      takeProfitPct: number
      stopLossPct: number
    }
  | {
      type: 'moonboy_closed'
      symbol: string
      mint: string
      pnlPct: number
      reason: string
      ageHours: number
      swapSig: string
    }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const message = formatMessage(payload)
  await sendTelegram(message)
}

function strategyBadge(strategy: string): string {
  const s = strategy.toLowerCase()
  if (s.includes('damm')) {
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

      const rugLine = payload.rugcheckScore != null && payload.rugcheckUrl
        ? `📊 Rugcheck: ${payload.rugcheckScore}/100\n   → ${payload.rugcheckUrl}`
        : payload.rugcheckScore != null
          ? `📊 Rugcheck: ${payload.rugcheckScore}/100`
          : '📊 Rugcheck: N/A'

      const holdersLine = (payload.holderCount != null && payload.topHolderPct != null)
        ? `👥 Holders: ${payload.holderCount.toLocaleString()} (top ${payload.topHolderPct}%)`
        : '👥 Holders: N/A'

      return [
        `🟢 *BUY* ${payload.symbol}`,
        `💰 Deployed: ${payload.solDeposited} SOL`,
        `💵 Entry Price: ${formatUsdPrice(entryUsd)}${entrySolPart}`,
        rugLine,
        holdersLine,
        `📈 ${dexUrl}`,
      ].join('\n')
    }

    case 'position_closed': {
      const netPnl = payload.netPnlSol ?? 0
      const netSign = netPnl >= 0 ? '+' : ''
      const ilPct = payload.ilPct !== null && Number.isFinite(payload.ilPct)
        ? `${payload.ilPct.toFixed(2)}%`
        : 'N/A'
      return [
        `🔴 *SELL* ${payload.symbol}`,
        `Reason: ${payload.reason}`,
        `Claimable Fees: *${payload.claimableFeesUsd != null ? `$${payload.claimableFeesUsd.toFixed(2)}` : 'N/A'}*`,
        `IL: ${ilPct} | Net PNL: ${netSign}${netPnl} SOL`,
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

    // position_fee_yield_extended removed in simplified model

    // candidate_found intentionally produces no Telegram message (noise reduction)
    case 'candidate_found':
      return ''

    // position_rebalanced removed in simplified model

    case 'pnl_unavailable_warning':
      return [
        `⚠️ *PnL Feed Unavailable* ${payload.symbol}`,
        `Strategy: ${payload.strategy}`,
        `Position: \`${payload.positionId}\``,
        `Reason: ${payload.reason}`,
        `Age: ${payload.ageHours}h`,
        `Stop-loss/take-profit protection is degraded.`,
      ].join('\n')

    case 'moonboy_opened': {
      const dexUrl = `https://dexscreener.com/solana/${payload.mint}`
      const pnlSign = payload.takeProfitPct >= 0 ? '+' : ''
      return [
        `🌙 *MOONBOY BUY* ${payload.symbol}`,
        `💵 Buy Size: $${payload.buyUsd} (~${payload.solSpent.toFixed(4)} SOL)`,
        `📊 Entry: ${formatUsdPrice(payload.entryPriceUsd)}`,
        `🎯 TP: ${pnlSign}${payload.takeProfitPct}% | SL: ${payload.stopLossPct}%`,
        `📈 ${dexUrl}`,
      ].join('\n')
    }

    case 'moonboy_closed': {
      const pnlSign = payload.pnlPct >= 0 ? '+' : ''
      const pnlEmoji = payload.pnlPct >= 0 ? '🟢' : '🔴'
      const dexUrl = `https://dexscreener.com/solana/${payload.mint}`
      return [
        `${pnlEmoji} *MOONBOY SELL* ${payload.symbol}`,
        `PnL: *${pnlSign}${payload.pnlPct.toFixed(2)}%*`,
        `Reason: ${payload.reason}`,
        `Held: ${payload.ageHours}h`,
        `Sig: \`${payload.swapSig.slice(0, 12)}…\``,
        `📈 ${dexUrl}`,
      ].join('\n')
    }

    case 'warning':
      return `⚠️ *Warning*\n${payload.message}`

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

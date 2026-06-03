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
      // meteoracleScore removed for ultra-minimal LP model (no scoring)
      rugcheckScore?: number | string
      rugcheckUrl?: string
      holderCount?: number
      topHolderPct?: number
      poolAddress?: string
      mint?: string
      ageMinutes?: number
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
      // Rich 4-rule exit diagnostics (added for ultra-minimal LP model)
      netPnlPct?: number
      feeTvl4hAvg?: number
      feeTvlSampleCount?: number
      oorMinutes?: number
      triggeredRule?: string
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

function escapeMarkdown(text: string): string {
  // Escape special Markdown characters
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function formatMessage(payload: AlertPayload): string {
  switch (payload.type) {
    case 'position_opened': {
      const safeSymbol = escapeMarkdown(payload.symbol)
      const entryUsd = payload.entryPriceUsd ?? payload.entryPrice
      const entrySol = payload.entryPriceSol ?? ''
      const entrySolPart = entrySol ? ` | ${entrySol} SOL` : ''

      const rugLine = payload.rugcheckScore != null && payload.rugcheckUrl
        ? `📊 Rugcheck: ${payload.rugcheckScore}/100\n   → [Rugcheck](${payload.rugcheckUrl})`
        : payload.rugcheckScore != null
          ? `📊 Rugcheck: ${payload.rugcheckScore}/100`
          : '📊 Rugcheck: N/A'

      const holdersLine = (payload.holderCount != null && payload.topHolderPct != null)
        ? `👥 Holders: ${payload.holderCount.toLocaleString()} (top ${payload.topHolderPct}%)`
        : '👥 Holders: N/A'

      const ageLine = payload.ageMinutes != null
        ? `🕒 Meteora pool age: ${payload.ageMinutes} min`
        : ''

      const meteoraUrl = payload.poolAddress
        ? `https://app.meteora.ag/dlmm/${payload.poolAddress}`
        : null
      const meteoraLine = meteoraUrl
        ? `📈 [Meteora DLMM](${meteoraUrl})`
        : ''

      return [
        `🟢 *DLMM* ${safeSymbol}`,
        `💰 Deployed: ${payload.solDeposited} SOL`,
        `💵 Entry Price: ${formatUsdPrice(entryUsd)}${entrySolPart}`,
        rugLine,
        holdersLine,
        ageLine,
        meteoraLine,
      ].filter(Boolean).join('\n')
    }

    case 'position_closed': {
      const safeSymbol = escapeMarkdown(payload.symbol)
      const safeReason = escapeMarkdown(payload.reason)
      const lines = [
        `🔴 *SELL* ${safeSymbol}`,
        `Reason: ${safeReason}`,
      ]

      if (payload.claimableFeesUsd != null) {
        lines.push(`Claimable Fees: *$${payload.claimableFeesUsd.toFixed(2)}*`)
      }

      if (payload.netPnlPct != null) {
        const sign = payload.netPnlPct >= 0 ? '+' : ''
        lines.push(`Net PnL (price + fees): *${sign}${payload.netPnlPct.toFixed(1)}%*`)
      } else if (payload.netPnlSol != null) {
        const sign = payload.netPnlSol >= 0 ? '+' : ''
        lines.push(`Net PnL: ${sign}${payload.netPnlSol} SOL`)
      }

      if (payload.feeTvl4hAvg != null) {
        const sc = payload.feeTvlSampleCount ? ` (${payload.feeTvlSampleCount} samples)` : ''
        lines.push(`4h Fee/TVL avg: ${payload.feeTvl4hAvg.toFixed(2)}%${sc}`)
      }

      if (payload.oorMinutes != null) {
        lines.push(`Time OOR at close: ${payload.oorMinutes}m`)
      }

      lines.push(`Held for: ${payload.ageHours}h`)
      lines.push(`Strategy: ${payload.strategy}`)

      return lines.join('\n')
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

    case 'warning':
      return `⚠️ *Warning*\n${escapeMarkdown(payload.message)}`

    case 'error':
      return `❌ *Bot Error*\n${escapeMarkdown(payload.message)}`

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

import axios from 'axios'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

type AlertPayload =
  | { type: 'position_opened'; symbol: string; strategy: string; solDeposited: number; entryPrice: number }
  | { type: 'position_closed'; symbol: string; strategy: string; reason: string; feesEarnedSol: number; ageHours: number }
  | { type: 'position_oor'; symbol: string; strategy: string; currentPrice: number; binRangeLower: number; binRangeUpper: number; oorExitMinutes: number }
  | { type: 'candidate_found'; symbol: string; strategy: string; score: number; mcUsd: number; volume24h: number }
  | { type: 'error'; message: string }

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const message = formatMessage(payload)
  await sendTelegram(message)
}

// ---------------------------------------------------------------------------
// Message formatter
// ---------------------------------------------------------------------------

function formatMessage(payload: AlertPayload): string {
  switch (payload.type) {
    case 'position_opened':
      return [
        `⚡ *Position Opened*`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Entry: $${payload.entryPrice.toFixed(8)}`,
        `Deployed: ${payload.solDeposited.toFixed(3)} SOL`,
      ].join('\n')

    case 'position_closed':
      return [
        `✅ *Position Closed*`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Reason: ${payload.reason}`,
        `Fees earned: ${payload.feesEarnedSol.toFixed(4)} SOL`,
        `Duration: ${payload.ageHours}h`,
      ].join('\n')

    case 'position_oor':
      return [
        `⚠️ *Out of Range*`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Current price: $${payload.currentPrice.toFixed(8)}`,
        `Range: $${payload.binRangeLower.toFixed(8)} – $${payload.binRangeUpper.toFixed(8)}`,
        `Will close in: ${payload.oorExitMinutes}min if not recovered`,
      ].join('\n')

    case 'candidate_found':
      return [
        `🔍 *New Candidate*`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Score: ${payload.score}/100`,
        `MC: $${formatNum(payload.mcUsd)}`,
        `Vol 24h: $${formatNum(payload.volume24h)}`,
      ].join('\n')

    case 'error':
      return `❌ *Bot Error*\n${payload.message}`

    default:
      return `🤖 Meteoracle event`
  }
}

// ---------------------------------------------------------------------------
// Telegram sender
// ---------------------------------------------------------------------------

async function sendTelegram(text: string): Promise<void> {
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
    // Never let alerter failures crash the bot
    console.error('[alerter] Telegram send failed:', err)
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

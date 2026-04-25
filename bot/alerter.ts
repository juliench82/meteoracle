import axios from 'axios'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

type AlertPayload =
  | { type: 'position_opened'; symbol: string; strategy: string; solDeposited: number; entryPrice: number; positionId: string }
  | { type: 'position_closed'; symbol: string; strategy: string; reason: string; feesEarnedSol: number; ilPct: number; ageHours: number }
  | { type: 'position_oor'; symbol: string; strategy: string; currentPrice: number; binRangeLower: number; binRangeUpper: number; oorExitMinutes: number }
  | { type: 'candidate_found'; symbol: string; strategy: string; score: number; mcUsd: number; volume24h: number; bondingCurvePct?: number }
  | { type: 'orphan_detected'; symbol: string; positionPubKey: string; poolAddress: string }
  | { type: 'cooldown_skip'; symbol: string; strategy: string; cooldownHours: number }
  | { type: 'pre_grad_pool_created'; symbol: string; mint: string; pool: string; sol: number }
  | { type: 'pre_grad_create_failed'; mint: string; error: string }
  | { type: 'pre_grad_opened'; symbol: string; positionId: string; poolAddress: string; bondingCurvePct: number }
  | { type: 'pre_grad_closed'; symbol: string; positionId: string; ageMin: number; reason: string }
  | { type: 'pre_grad_graduated'; symbol: string; positionId: string; bondingCurvePct: number }
  | { type: 'error'; message: string }

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const message = formatMessage(payload)
  await sendTelegram(message)
}

function strategyBadge(strategy: string): string {
  // Pre-grad / DAMM v2 strategies contain 'damm', 'pre_grad', or 'pre-grad'
  const s = strategy.toLowerCase()
  if (s.includes('damm') || s.includes('pre_grad') || s.includes('pre-grad')) {
    return '🌱 DAMM v2'
  }
  return '📊 DLMM'
}

function formatMessage(payload: AlertPayload): string {
  switch (payload.type) {
    case 'position_opened':
      return [
        `⚡ *Position Opened*`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Entry: $${payload.entryPrice.toFixed(8)}`,
        `Deployed: ${payload.solDeposited.toFixed(3)} SOL`,
        `ID: \`${payload.positionId}\``,
        `→ To close manually: /close ${payload.positionId}`,
      ].join('\n')

    case 'position_closed': {
      const ilSign = payload.ilPct <= 0 ? '' : '+'
      const feeLine = payload.feesEarnedSol > 0
        ? `Fees earned: *${payload.feesEarnedSol.toFixed(6)} SOL*`
        : `Fees earned: 0 SOL`
      const ilLine = `IL: ${ilSign}${payload.ilPct.toFixed(2)}%`
      const isSmartRebalance = payload.reason.startsWith('smart_rebalance')
      const header = isSmartRebalance ? `🔄 *Smart Rebalance*` : `✅ *Position Closed*`
      return [
        header,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Reason: ${payload.reason}`,
        feeLine,
        ilLine,
        `Duration: ${payload.ageHours}h`,
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

    case 'candidate_found': {
      const badge = strategyBadge(payload.strategy)
      const curveLine = payload.bondingCurvePct !== undefined
        ? `\nCurve: ${payload.bondingCurvePct.toFixed(1)}% ${bondingCurveEmoji(payload.bondingCurvePct)}`
        : ''
      return [
        `🔍 *New Candidate* — ${badge}`,
        `Token: \`${payload.symbol}\``,
        `Strategy: ${payload.strategy}`,
        `Score: ${payload.score}/100`,
        `MC: $${formatNum(payload.mcUsd)}`,
        `Vol 24h: $${formatNum(payload.volume24h)}${curveLine}`,
      ].join('\n')
    }

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

    case 'pre_grad_closed':
      return [
        `🌿 *Pre-Grad Position Closed*`,
        `Token: \`${payload.symbol}\``,
        `ID: \`${payload.positionId}\``,
        `Reason: ${payload.reason}`,
        `Age: ${payload.ageMin}min`,
      ].join('\n')

    case 'pre_grad_graduated':
      return [
        `🎓 *Token Graduated!*`,
        `Token: \`${payload.symbol}\``,
        `ID: \`${payload.positionId}\``,
        `Curve: ${payload.bondingCurvePct.toFixed(1)}% ✅`,
        `_Position should be closed and re-evaluated on DLMM_`,
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

/**
 * telegram.ts
 *
 * Thin wrapper around Telegram Bot API sendMessage.
 * Silently swallows errors — alerts are best-effort, never block trading.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your personal chat ID or group ID
 *
 * Usage:
 *   import { sendTelegram } from './telegram'
 *   await sendTelegram('Hello from the bot!')
 */

import axios from 'axios'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   ?? ''

export async function sendTelegram(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    // Not configured — silently skip (don't crash the bot)
    return
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:    CHAT_ID,
        text,
        parse_mode: 'HTML',
      },
      { timeout: 5_000 }
    )
  } catch (err) {
    // Best-effort: log but never throw
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[telegram] failed to send alert: ${message}`)
  }
}

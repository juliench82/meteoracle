/**
 * bot/telegram-bot.ts
 *
 * Telegram control bot for Meteoracle (local-state only).
 * Full control from Telegram: start/stop, dry/live, status, positions, tick, close, add, etc.
 */

import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { exec } from 'child_process'
import { promisify } from 'util'
import { getBotState, setBotState } from '@/lib/botState'
import { closePosition } from '@/bot/executor'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { getOpenLpPositions, getOpenMoonboys } from '@/lib/local-state'
import { getTelegramAllowedUsers, isTelegramCommandAllowed } from '@/lib/telegram-auth'

const execAsync = promisify(exec)
const PM2 = '/usr/local/bin/pm2'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? ''
const ALLOWED_USER_IDS = getTelegramAllowedUsers()
const POLL_MS = 2000

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[telegram-bot] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing')
  process.exit(1)
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`

async function sendMessage(text: string, chatId = CHAT_ID) {
  try {
    await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
  } catch (e) {
    console.error('[telegram] sendMessage failed:', e)
  }
}

async function reply(text: string) {
  // In the polling handler we have the actual chatId from the update.
  // For simplicity in stubs we use the default CHAT_ID.
  await sendMessage(text)
}

async function handleUpdate(update: any) {
  const msg = update.message
  if (!msg?.text) return

  const userId = msg.from?.id
  const chatId = msg.chat?.id
  const text = msg.text.trim()

  if (!isTelegramCommandAllowed(userId, chatId)) return

  const [rawCmd, ...args] = text.split(/\s+/)
  const cmd = rawCmd?.toLowerCase()

  if (cmd === '/help' || cmd === '/start') {
    const help = [
      '*Meteoracle Commands*',
      '',
      '/status — current state + positions count',
      '/positions — detailed list of open LP + Moonboy',
      '/tick — force one scanner + monitor cycle',
      '/dry — enable dry-run mode',
      '/live — enable live trading',
      '/stop — emergency stop',
      '/restart — resume workers',
      '/close <id> — force close one position',
      '/add <id> <SOL> — add liquidity to position',
      '/help — this message',
      '',
      'All state from local files (state/ folder).',
    ].join('\n')
    await sendMessage(help, chatId)
    return
  }

  if (cmd === '/status') {
    const state = await getBotState()
    const lp = getOpenLpPositions()
    const mb = getOpenMoonboys()

    let msg = `*Bot Status*\n`
    msg += `Enabled: ${state.enabled}\n`
    msg += `Dry-run: ${state.dry_run}\n`
    msg += `Paused: ${state.paused}\n\n`
    msg += `Open LP: ${lp.length}\n`
    msg += `Open Moonboy: ${mb.length}\n`

    await sendMessage(msg, chatId)
    return
  }

  if (cmd === '/positions') {
    const lp = getOpenLpPositions()
    const mb = getOpenMoonboys()

    let msg = '*Open Positions*\n\n'

    if (lp.length === 0 && mb.length === 0) {
      msg += 'No open positions.'
    } else {
      if (lp.length > 0) {
        msg += `*LP Positions (${lp.length})*\n`
        lp.forEach((p: any) => {
          msg += `• ${p.symbol} — ${p.sol_deposited} SOL\n`
        })
      }
      if (mb.length > 0) {
        msg += `\n*Moonboy Positions (${mb.length})*\n`
        mb.forEach((p: any) => {
          msg += `• ${p.symbol}\n`
        })
      }
    }

    await sendMessage(msg, chatId)
    return
  }

  if (cmd === '/tick') {
    const [scanResult, monitorResult] = await Promise.allSettled([
      runScanner().then((r: any) => `Scanner: ${r.scanned} scanned, ${r.opened} opened`),
      monitorPositions().then((r: any) => `Monitor: ${r.checked} checked, ${r.closed} closed`),
    ])

    const scanLine = scanResult.status === 'fulfilled' ? scanResult.value : `❌ scanner error`
    const monitorLine = monitorResult.status === 'fulfilled' ? monitorResult.value : `❌ monitor error`

    await sendMessage([scanLine, monitorLine].join('\n'), chatId)
    return
  }

  if (cmd === '/dry') {
    await setBotState({ dry_run: true })
    await sendMessage('Dry-run mode enabled.', chatId)
    return
  }

  if (cmd === '/live') {
    await setBotState({ dry_run: false })
    await sendMessage('Live mode enabled (real money).', chatId)
    return
  }

  if (cmd === '/stop') {
    await setBotState({ enabled: false, paused: true })
    try {
      await execAsync(`${PM2} stop meteoracle-worker meteoracle-telegram`)
      await sendMessage('Bot stopped.', chatId)
    } catch {
      await sendMessage('Stop command sent.', chatId)
    }
    return
  }

  if (cmd === '/restart') {
    await setBotState({ enabled: true, paused: false })
    try {
      await execAsync(`${PM2} restart meteoracle-worker meteoracle-telegram`)
      await sendMessage('Bot restarted.', chatId)
    } catch {
      await sendMessage('Restart command sent.', chatId)
    }
    return
  }

  if (cmd.startsWith('/close ')) {
    const id = text.split(' ', 2)[1]?.trim()
    if (!id) {
      await sendMessage('Usage: /close <id>', chatId)
      return
    }
    try {
      const ok = await closePosition(id, 'manual_telegram')
      await sendMessage(ok ? `Closed ${id}.` : `Failed to close ${id}.`, chatId)
    } catch (e) {
      await sendMessage(`Error: ${e instanceof Error ? e.message : String(e)}`, chatId)
    }
    return
  }

  if (cmd === '/orphans' || cmd === '/candidates' || cmd === '/rebalance') {
    await sendMessage(`${cmd} is not available in the current simplified build.`, chatId)
    return
  }

  await sendMessage('Unknown command. Use /help', chatId)
}

async function getUpdates(offset = 0) {
  try {
    const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=25`)
    const json = await res.json()
    return json.result || []
  } catch (e) {
    console.error('[telegram] getUpdates error:', e)
    return []
  }
}

async function main() {
  console.log('[telegram-bot] starting (long polling, local-state only)...')
  let offset = 0

  while (true) {
    try {
      const updates = await getUpdates(offset)
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1)
        if (update.message) {
          handleUpdate(update).catch(err => {
            console.error('[telegram-bot] handler error:', err)
          })
        }
      }
    } catch (e) {
      console.error('[telegram-bot] poll error:', e)
      await new Promise(r => setTimeout(r, 3000))
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

main().catch(err => {
  console.error('[telegram-bot] fatal:', err)
  process.exit(1)
})
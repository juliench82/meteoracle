/**
 * bot/telegram-bot.ts
 *
 * Telegram control bot for Meteoracle (long polling).
 * Full control from Telegram: start/stop, dry/live, status, positions, tick, close, etc.
 *
 * Run as separate PM2 process: meteoracle-telegram
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
    const help = [
      '*Meteoracle Commands*',
      '',
      '/status — current state + positions count',
      '/positions — detailed list of open LP + Moonboy (with 2x targets)',
      '/tick — force one scanner + monitor cycle',
      '/dry — enable dry-run mode',
      '/live — disable dry-run (real money)',
      '/stop — emergency stop (worker + telegram)',
      '/restart — resume bot',
      '/close <id> — force close one position (LP or Moonboy)',
      '',
      'All state is read from local files (state/ folder).',
    ].join('\n')
    await sendMessage(help, chatId)
    return

  if (text === '/pause') {
    await setBotState({ paused: true });
    await sendMessage('Bot paused (no new actions)', chatId);
    return;
  }

  if (text === '/resume') {
    await setBotState({ paused: false });
    await sendMessage('Bot resumed', chatId);
    return;
  }

  if (text === '/config') {
  if (text === '/live') {
    await sendMessage('⚠️ This will enable LIVE trading (real money). Type /live-confirm to proceed.', chatId);
    return;
  }
  if (text === '/live-confirm') {
    await setBotState({ dry_run: false });
    await sendMessage('LIVE mode ENABLED — real money at risk.', chatId);
    return;
  }    await sendMessage(msg, chatId);
    return;
  }    msg += `Open LP positions: ${lp.length}\n`
    msg += `Open Moonboy: ${mb.length}/3`

    await sendMessage(msg, chatId)
    return
  }

  if (text === '/positions') {
    const lp = getOpenLpPositions()
    const mb = getOpenMoonboys()

    let msg = '*Open Positions*\n\n'

    if (lp.length === 0 && mb.length === 0) {
      msg += 'No open positions.'
    } else {
      if (lp.length > 0) {
        msg += `*LP Positions (${lp.length})*\n`
        lp.forEach(p => {
          msg += `• ${p.symbol} — ${p.sol_deposited} SOL\n`
        })
        msg += '\n'
      }
      if (mb.length > 0) {
        msg += `*Moonboy Positions (${mb}/3)*\n`
        mb.forEach(m => {
          const target = m.target_price_usd ? ` → ${m.target_price_usd.toFixed(6)} (2x)` : ''
          msg += `• ${m.symbol} @ ${m.entry_price_usd.toFixed(6)}${target}\n`
        })
      }
    }
    await sendMessage(msg, chatId)
    return
  }

  if (text === '/tick') {
    await sendMessage('Forcing scanner + monitor tick...', chatId)
    try {
      await Promise.all([runScanner(), monitorPositions()])
      await sendMessage('Tick completed.', chatId)
    } catch (e) {
      await sendMessage('Tick failed (check logs).', chatId)
    }
    return
  }

  if (text === '/dry') {
    await setBotState({ dry_run: true })
    await sendMessage('DRY_RUN enabled ✓', chatId)
    return
  }

  if (text === '/live') {
    await setBotState({ dry_run: false })
    await sendMessage('⚠️ LIVE mode enabled — real money at risk', chatId)
    return
  }

  if (text === '/stop') {
    await setBotState({ enabled: false, paused: true })
    try {
      await execAsync(`${PM2} stop meteoracle-worker meteoracle-telegram`)
      await sendMessage('Bot stopped (both processes).', chatId)
    } catch (e) {
      await sendMessage('Stop command sent to PM2 (check logs).', chatId)
    }
    return
  }

  if (text === '/restart') {
    await setBotState({ enabled: true, paused: false })
    try {
      await execAsync(`${PM2} restart meteoracle-worker meteoracle-telegram`)
      await sendMessage('Bot restarted.', chatId)
    } catch (e) {
      await sendMessage('Restart command sent to PM2.', chatId)
    }
    return
  }

  if (text.startsWith('/close ')) {
    const id = text.split(' ', 2)[1]?.trim()
    if (!id) {
      await sendMessage('Usage: /close <id or mint or symbol>', chatId)
      return
    }
    try {
      const ok = await closePosition(id, 'manual_telegram')
      if (ok) {
        await sendMessage(`LP position ${id} closed.`, chatId)
        return
      }
    } catch (e) {}
    const mb = getOpenMoonboys()
    const moonboy = mb.find(m => m.mint === id || m.symbol.toLowerCase() === id.toLowerCase())
    if (moonboy) {
      removeOpenMoonboy(moonboy.mint)
      await sendMessage(`Moonboy ${moonboy.symbol} removed from tracking.\n(Manual sell may still be needed if tokens remain.)`, chatId)
      return
    }
    await sendMessage(`No position found with: ${id}`, chatId)
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
  console.log('[telegram-bot] starting (long polling)...')
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

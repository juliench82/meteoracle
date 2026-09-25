/**
 * Hermetic tests for the extracted Telegram command handlers (AC-B6.4, AC-B6.5).
 *
 * The network layer (`bot/telegram-bot.ts`) is NOT imported: `send`,
 * `getBotState` and `setBotState` are injected fakes, so nothing here boots a
 * Telegram client, reads a bot token, or touches `state/` on disk.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  handleStartCommand,
  handleLiveCommand,
  resolveHardKills,
  LIVE_PINNED_NO_OP_MESSAGE,
  LIVE_ENABLED_MESSAGE,
} from '@/bot/command-handlers'
import type { CommandDeps, CommandEnv } from '@/bot/command-handlers'
import { resolveEffectiveGates } from '@/lib/gates'
import type { BotState } from '@/lib/botState'

const DEFAULT_STATE: BotState = {
  enabled: false,
  dry_run: true,
  is_running: false,
  running_since: null,
  sync_fail_count: 0,
  paused: false,
}

/** A fake command environment: recorded sends, recorded writes, in-memory state. */
function makeDeps(initial: Partial<BotState>, env: CommandEnv) {
  let state: BotState = { ...DEFAULT_STATE, ...initial }
  const sent: string[] = []
  const writes: Partial<BotState>[] = []
  const order: string[] = []
  const deps: CommandDeps = {
    send: async (text: string) => {
      order.push('send')
      sent.push(text)
    },
    getBotState: async () => {
      order.push('getBotState')
      return { ...state }
    },
    setBotState: async (patch: Partial<BotState>) => {
      order.push('setBotState')
      writes.push(patch)
      state = { ...state, ...patch }
    },
    env,
  }
  return { deps, sent, writes, order, getState: () => state }
}

describe('resolveHardKills — operator hard-kills are parsed exactly as worker.ts does', () => {
  it('absent flags mean "not killed"', () => {
    const r = resolveHardKills({})
    expect(r.flags).toEqual({ monitorEnabled: true, scannerEnabled: true })
    expect(r.killed).toEqual([])
  })

  it('naming each kill: LP_MONITOR_ENABLED / LP_SCANNER_ENABLED / legacy SCANNER_ENABLED', () => {
    expect(resolveHardKills({ LP_MONITOR_ENABLED: 'false' }).killed).toEqual(['LP_MONITOR_ENABLED=false'])
    expect(resolveHardKills({ LP_SCANNER_ENABLED: 'false' }).killed).toEqual(['LP_SCANNER_ENABLED=false'])
    expect(resolveHardKills({ SCANNER_ENABLED: 'false' }).killed).toEqual(['SCANNER_ENABLED=false'])
  })

  it('the legacy SCANNER_ENABLED folds into the scanner flag (and only that one)', () => {
    const r = resolveHardKills({ SCANNER_ENABLED: 'false' })
    expect(r.flags.monitorEnabled).toBe(true)
    expect(r.flags.scannerEnabled).toBe(false)
  })

  it('a non-"false" value does NOT hard-kill', () => {
    const r = resolveHardKills({ LP_MONITOR_ENABLED: 'no', LP_SCANNER_ENABLED: '0' })
    expect(r.killed).toEqual([])
    expect(r.flags).toEqual({ monitorEnabled: true, scannerEnabled: true })
  })
})

describe('AC-B6.5 — /start reports the EFFECTIVE gate state, never a claim of future work', () => {
  it('enabled + dry-run are read back AFTER the write and reported', async () => {
    // Prior /stop left the bot disabled; /start must flip it and report the result.
    const h = makeDeps({ enabled: false, dry_run: true, paused: true }, {})
    const text = await handleStartCommand(h.deps)

    expect(h.writes).toEqual([{ enabled: true, paused: false }])
    expect(h.getState()).toMatchObject({ enabled: true, paused: false })
    expect(text).toContain('Bot enabled (soft start).')
    expect(text).toContain('Effective gate: ENABLED')
    expect(text).toContain('Dry-run: ON')
    // The old, false promise must be gone.
    expect(text).not.toContain('next scheduled tick')
    expect(text).not.toContain('will pick up work')
    expect(text).toBe(h.sent[0])
  })

  it('the reply is computed from the state re-read AFTER the write (setBotState runs first)', async () => {
    const h = makeDeps({ enabled: false }, {})
    await handleStartCommand(h.deps)
    expect(h.order.indexOf('setBotState')).toBeLessThan(h.order.indexOf('getBotState'))
    expect(h.order.indexOf('getBotState')).toBeLessThan(h.order.indexOf('send'))
  })

  it('LP_MONITOR_ENABLED=false: says DISABLED explicitly, names the env pin, promises no work', async () => {
    const h = makeDeps({ enabled: false, dry_run: true }, { LP_MONITOR_ENABLED: 'false' })
    const text = await handleStartCommand(h.deps)

    expect(text).toContain('Effective gate: DISABLED')
    expect(text).not.toContain('Effective gate: ENABLED')
    expect(text).toContain('LP_MONITOR_ENABLED=false')
    expect(text).toContain('No monitor/scanner work will run until the env pin is removed')
    expect(text).not.toContain('next scheduled tick')
    expect(text).not.toContain('will pick up work')
  })

  it('LP_SCANNER_ENABLED=false and the legacy SCANNER_ENABLED=false are both surfaced', async () => {
    const scanner = makeDeps({ enabled: false }, { LP_SCANNER_ENABLED: 'false' })
    expect(await handleStartCommand(scanner.deps)).toContain('LP_SCANNER_ENABLED=false')

    const legacy = makeDeps({ enabled: false }, { SCANNER_ENABLED: 'false' })
    const text = await handleStartCommand(legacy.deps)
    expect(text).toContain('Effective gate: DISABLED')
    expect(text).toContain('SCANNER_ENABLED=false')
  })

  it('a hard-killed /start still persists enabled=true (botState is the source of truth) but reports DISABLED', async () => {
    const h = makeDeps({ enabled: false }, { LP_MONITOR_ENABLED: 'false' })
    await handleStartCommand(h.deps)
    expect(h.getState()).toMatchObject({ enabled: true, paused: false })
  })

  it('dry-run is reported effectively: botState decides when there is no pin', async () => {
    const live = makeDeps({ enabled: false, dry_run: false }, {})
    expect(await handleStartCommand(live.deps)).toContain('Dry-run: OFF (live trading)')

    const dry = makeDeps({ enabled: false, dry_run: true }, {})
    expect(await handleStartCommand(dry.deps)).toContain('Dry-run: ON.')
  })

  it('BOT_DRY_RUN=true is reported as the pin (not as a plain botState setting)', async () => {
    const h = makeDeps({ enabled: false, dry_run: false }, { BOT_DRY_RUN: 'true' })
    expect(await handleStartCommand(h.deps)).toContain('Dry-run: ON (pinned by BOT_DRY_RUN=true)')
  })

  it('a pause observed at read-back is reported as PAUSED, not as ENABLED', async () => {
    // Simulate a concurrent pause landing between the /start write and the re-read.
    const sent: string[] = []
    const deps: CommandDeps = {
      send: async (t: string) => { sent.push(t) },
      getBotState: async () => ({ ...DEFAULT_STATE, enabled: true, paused: true }),
      setBotState: async () => {},
      env: {},
    }
    const text = await handleStartCommand(deps)
    expect(text).toContain('Effective gate: PAUSED')
    expect(text).not.toContain('Effective gate: ENABLED')
    expect(sent).toEqual([text])
  })
})

describe('AC-B6.4 — /live under BOT_DRY_RUN=true is a loud no-op, never a success claim', () => {
  it('the required refusal message is byte-exact', () => {
    expect(LIVE_PINNED_NO_OP_MESSAGE).toBe(
      'no-op: BOT_DRY_RUN=true forces dry-run; remove the env pin and restart to go live',
    )
  })

  it('BOT_DRY_RUN=true: sends exactly the no-op message and never reports success', async () => {
    const h = makeDeps({ enabled: true, dry_run: false }, { BOT_DRY_RUN: 'true' })
    const text = await handleLiveCommand(h.deps)

    expect(h.sent).toEqual([LIVE_PINNED_NO_OP_MESSAGE])
    expect(text).toBe(LIVE_PINNED_NO_OP_MESSAGE)
    expect(h.sent.join('\n')).not.toContain('Live mode enabled')
    // It is a no-op IN EFFECT: dry-run is still on.
    expect(resolveEffectiveGates(h.getState(), { BOT_DRY_RUN: 'true' }, {}).dryRun).toBe(true)
  })

  it('the pinned refusal still records the operator intent (dry_run:false) so the guidance is true', async () => {
    const h = makeDeps({ enabled: true, dry_run: true }, { BOT_DRY_RUN: 'true' })
    await handleLiveCommand(h.deps)
    expect(h.sent).toEqual([LIVE_PINNED_NO_OP_MESSAGE])
    expect(h.writes).toEqual([{ dry_run: false }])
    // ...and with the pin removed, that persisted intent IS live.
    expect(resolveEffectiveGates(h.getState(), {}, {}).dryRun).toBe(false)
  })

  it('without the pin, /live takes effect and reports success', async () => {
    const h = makeDeps({ enabled: true, dry_run: true }, {})
    const text = await handleLiveCommand(h.deps)
    expect(text).toBe(LIVE_ENABLED_MESSAGE)
    expect(h.sent).toEqual([LIVE_ENABLED_MESSAGE])
    expect(h.getState()).toMatchObject({ dry_run: false })
  })

  it('the pin is a strict match: BOT_DRY_RUN=TRUE does not pin, so /live reports success', async () => {
    const h = makeDeps({ enabled: true, dry_run: true }, { BOT_DRY_RUN: 'TRUE' })
    expect(await handleLiveCommand(h.deps)).toBe(LIVE_ENABLED_MESSAGE)
    expect(h.getState()).toMatchObject({ dry_run: false })
  })

  it('BOT_DRY_RUN unset but botState.dry_run=true: /live takes effect (botState is the source of truth)', async () => {
    const h = makeDeps({ enabled: true, dry_run: true }, {})
    expect(await handleLiveCommand(h.deps)).toBe(LIVE_ENABLED_MESSAGE)
  })
})

describe('extraction — the handler module is free of the network layer', () => {
  it('bot/command-handlers.ts performs no network or polling I/O', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'bot', 'command-handlers.ts'),
      'utf8',
    )
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const forbidden of ['fetch(', 'setInterval', 'setTimeout', 'getUpdates', 'api.telegram.org']) {
      expect(code).not.toContain(forbidden)
    }
  })

  it('telegram-bot.ts delegates /start and /live to the extracted handlers', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'bot', 'telegram-bot.ts'),
      'utf8',
    )
    expect(src).toContain("from '@/bot/command-handlers'")
    expect(src).toContain('handleStartCommand(commandDeps(chatId))')
    expect(src).toContain('handleLiveCommand(commandDeps(chatId))')
    // The old always-success /start promise must be gone.
    expect(src).not.toContain('It will pick up work on the next scheduled tick')
  })
})
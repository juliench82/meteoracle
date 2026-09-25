/**
 * bot/command-handlers.ts
 *
 * Command-handler logic extracted OUT of the Telegram network layer
 * (`bot/telegram-bot.ts`) so it can be unit-tested with a mocked send
 * (audit §M2 / plan B6, AC-B6.4 + AC-B6.5).
 *
 * The network layer keeps everything network-shaped: long-polling, `fetch`,
 * `sendMessage`, auth and process bootstrap.  Everything here is free of I/O
 * except through the injected `send` / `getBotState` / `setBotState` deps, so a
 * test can drive `/start` and `/live` with a fake send and assert the EXACT
 * reply without booting a Telegram client or touching the filesystem.
 *
 * Both replies report the EFFECTIVE gate state resolved by `lib/gates.ts`, so
 * the operator is never told work will happen when a hard-kill env blocks it
 * and never told "Live mode enabled" when `BOT_DRY_RUN=true` pins dry-run.
 */

import { resolveEffectiveGates } from '@/lib/gates'
import type { GateEnv, GateFlags } from '@/lib/gates'
import type { BotState } from '@/lib/botState'

/**
 * The env slice the command layer consults: the `BOT_*` startup seeds / dry-run
 * pin plus the operator hard-kills.
 */
export interface CommandEnv extends GateEnv {
  LP_MONITOR_ENABLED?: string
  LP_SCANNER_ENABLED?: string
  /** Legacy alias folded into the scanner hard-kill (`worker.ts` does the same). */
  SCANNER_ENABLED?: string
}

/** Injected dependencies — the network layer supplies the real implementations. */
export interface CommandDeps {
  /** The reply channel (Telegram `sendMessage`); mocked in tests. */
  send: (text: string) => Promise<void>
  /** The persisted, single-source-of-truth bot state. */
  getBotState: () => Promise<BotState>
  /** Mutates the persisted bot state. */
  setBotState: (patch: Partial<BotState>) => Promise<void>
  /** The env slice to resolve gates against (the caller passes `process.env`). */
  env: CommandEnv
}

/** The exact `/live` refusal while `BOT_DRY_RUN=true` pins dry-run for the process. */
export const LIVE_PINNED_NO_OP_MESSAGE =
  'no-op: BOT_DRY_RUN=true forces dry-run; remove the env pin and restart to go live'

/** The success reply `/live` sends only when it actually took effect. */
export const LIVE_ENABLED_MESSAGE = 'Live mode enabled (real money).'

export interface HardKillReport {
  /** Parsed flags for `resolveEffectiveGates` (one stream at a time). */
  flags: GateFlags
  /** Names of the env vars currently hard-killing work, for the reply. */
  killed: string[]
}

/**
 * Parse the operator hard-kill env flags EXACTLY as `worker.ts` does:
 * `LP_MONITOR_ENABLED !== 'false'` and
 * `LP_SCANNER_ENABLED !== 'false' && SCANNER_ENABLED !== 'false'`.
 * Also returns the human-readable names so `/start` can say *which* pin blocks work.
 */
export function resolveHardKills(env: CommandEnv): HardKillReport {
  const killed: string[] = []
  if (env.LP_MONITOR_ENABLED === 'false') killed.push('LP_MONITOR_ENABLED=false')
  if (env.LP_SCANNER_ENABLED === 'false') killed.push('LP_SCANNER_ENABLED=false')
  if (env.SCANNER_ENABLED === 'false') killed.push('SCANNER_ENABLED=false')
  return {
    killed,
    flags: {
      monitorEnabled: env.LP_MONITOR_ENABLED !== 'false',
      scannerEnabled: env.LP_SCANNER_ENABLED !== 'false' && env.SCANNER_ENABLED !== 'false',
    },
  }
}

function dryRunLabel(pinned: boolean, dryRun: boolean): string {
  if (!dryRun) return 'OFF (live trading)'
  return pinned ? 'ON (pinned by BOT_DRY_RUN=true)' : 'ON'
}

/**
 * Handle `/start`: enable `botState`, then report the EFFECTIVE gate state read
 * back after the write.  Never claims future work: if a hard-kill env blocks the
 * worker, the reply says so explicitly instead of "it will pick up work next tick".
 *
 * @returns the exact text that was sent (handy for assertions/logging).
 */
export async function handleStartCommand(deps: CommandDeps): Promise<string> {
  await deps.setBotState({ enabled: true, paused: false })

  // Re-read AFTER the write: report what the worker will actually see, not our intent.
  const state = await deps.getBotState()
  const { flags, killed } = resolveHardKills(deps.env)
  const gates = resolveEffectiveGates(state, deps.env, flags)

  const lines = ['Bot enabled (soft start).']

  if (gates.enabled) {
    lines.push(
      'Effective gate: ENABLED — the worker re-reads botState every tick, so this takes effect on the next cycle (~60s).',
    )
  } else if (killed.length > 0) {
    // botState.enabled=true but a hard-kill env closes the gate: say so, loudly,
    // and do NOT promise work that will not run.
    lines.push(`Effective gate: DISABLED — hard-killed by env ${killed.join(', ')}.`)
    lines.push(
      'No monitor/scanner work will run until the env pin is removed and the process restarts.',
    )
  } else if (gates.paused) {
    lines.push('Effective gate: PAUSED — no work will run until the bot is unpaused.')
  } else {
    lines.push('Effective gate: DISABLED — botState.enabled is not true.')
  }

  lines.push(`Dry-run: ${dryRunLabel(gates.dryRunPinnedByEnv, gates.dryRun)}.`)

  if (gates.enabled) {
    lines.push('Use /tick to force an immediate cycle.')
  }

  const text = lines.join('\n')
  await deps.send(text)
  return text
}

/**
 * Handle `/live`: switch off dry-run, unless `BOT_DRY_RUN=true` pins it for the
 * process lifetime.  Under the pin the command is a no-op IN EFFECT and reports
 * that loudly — it must NEVER answer "Live mode enabled" (AC-B6.4).
 *
 * The operator's intent is still persisted (`dry_run: false`) before the refusal,
 * which is what makes the guidance ("remove the env pin and restart to go live")
 * true: the pin is the only thing left holding dry-run on.  What changes is the
 * REPORT — no false success.
 *
 * @returns the exact text that was sent.
 */
export async function handleLiveCommand(deps: CommandDeps): Promise<string> {
  const state = await deps.getBotState()
  const gates = resolveEffectiveGates(state, deps.env, {})

  if (gates.dryRunPinnedByEnv) {
    // Persist the operator's intent, but refuse to claim success: the process pin
    // keeps dry-run on regardless, so nothing is live.
    await deps.setBotState({ dry_run: false })
    await deps.send(LIVE_PINNED_NO_OP_MESSAGE)
    return LIVE_PINNED_NO_OP_MESSAGE
  }

  await deps.setBotState({ dry_run: false })
  await deps.send(LIVE_ENABLED_MESSAGE)
  return LIVE_ENABLED_MESSAGE
}
/**
 * lib/gates.ts
 *
 * Pure resolver for the bot's EFFECTIVE enable / pause / dry-run gate state.
 *
 * Extracted from the worker loop and the Telegram command layer so the gate
 * semantics can be unit-tested without booting the monitor/scanner ticks or a
 * Telegram client (audit §M2 / plan B6, AC-B6.3).
 *
 * SINGLE SOURCE OF TRUTH for enable/pause is the persisted `botState`
 * (lib/botState.ts).  The env vars are NOT live gates:
 *
 *   - `BOT_ENABLED`   — STARTUP SEED ONLY.  It seeds `botState.enabled` once at
 *                       boot (lib/botState.ts `getInitialState` / restart
 *                       override) and is deliberately IGNORED here.  A process
 *                       started with `BOT_ENABLED=false` can still be enabled by
 *                       `/start`, and `BOT_ENABLED=true` must not re-enable a
 *                       bot the operator stopped with `/stop`.
 *   - `BOT_DRY_RUN`   — STARTUP SEED for `botState.dry_run` AND an operator
 *                       HARD PIN.  When it is exactly `'true'` the bot cannot go
 *                       live for the lifetime of the process, so
 *                       `dryRunPinnedByEnv` is true and `/live` must refuse
 *                       loudly instead of silently no-op'ing.
 *   - `LP_MONITOR_ENABLED` / `LP_SCANNER_ENABLED` (and the legacy
 *                       `SCANNER_ENABLED`) — operator HARD-KILLS.  The caller
 *                       parses them into `GateFlags`; a `false` flag kills work
 *                       for that stream regardless of `botState`.
 *
 * `resolveEffectiveGates` performs no I/O and reads no globals: the caller
 * passes the freshly-read `botState`, the relevant env values, and the parsed
 * hard-kill flags.  That makes it safe to call on every tick.
 */

import type { BotState } from './botState'

/** The env slice the gate resolver consults (a subset of `process.env`). */
export interface GateEnv {
  /** `BOT_ENABLED` — startup seed only; intentionally ignored by the resolver. */
  BOT_ENABLED?: string
  /** `BOT_DRY_RUN` — `'true'` pins dry-run for the process lifetime. */
  BOT_DRY_RUN?: string
}

/**
 * Operator hard-kill flags, already parsed from env by the caller
 * (`LP_MONITOR_ENABLED !== 'false'`, `LP_SCANNER_ENABLED !== 'false' && SCANNER_ENABLED !== 'false'`).
 *
 * Resolve ONE stream at a time and pass only that stream's flag: the worker's
 * `tickMonitor` passes `{ monitorEnabled }` and `tickScanner` passes
 * `{ scannerEnabled }`, so a monitor hard-kill can never suppress the scanner.
 * An omitted (undefined) flag means "not killed" — pass both only when
 * reporting the combined state (e.g. `/start`).
 */
export interface GateFlags {
  monitorEnabled?: boolean
  scannerEnabled?: boolean
}

/** The effective gate state the worker loop and the command layer must report. */
export interface EffectiveGates {
  /** Work is allowed: botState says enabled, not paused, and no hard-kill blocks it. */
  enabled: boolean
  /** botState.paused (single source of truth). */
  paused: boolean
  /** Effective dry-run: the operator's botState setting, or the env pin. */
  dryRun: boolean
  /** `BOT_DRY_RUN === 'true'` — a process-lifetime pin that `/live` cannot lift. */
  dryRunPinnedByEnv: boolean
}

export function resolveEffectiveGates(
  botState: Pick<BotState, 'enabled' | 'paused' | 'dry_run'>,
  env: GateEnv = {},
  flags: GateFlags = {},
): EffectiveGates {
  // botState is the single source of truth for enable/pause. `BOT_ENABLED` is
  // a startup seed already folded into botState and is deliberately not read.
  const paused = botState.paused === true
  const hardKilled = flags.monitorEnabled === false || flags.scannerEnabled === false
  const enabled = botState.enabled === true && !paused && !hardKilled

  // BOT_DRY_RUN='true' is a hard pin; otherwise the persisted botState decides.
  const dryRunPinnedByEnv = env.BOT_DRY_RUN === 'true'
  const dryRun = dryRunPinnedByEnv || botState.dry_run === true

  return { enabled, paused, dryRun, dryRunPinnedByEnv }
}
/**
 * lib/config-invariant-gate.ts
 *
 * Fail-closed open gate for the fee/TVL exit-vs-entry config invariant (H3).
 *
 * The pure predicate lives in lib/config-invariants.ts:
 *   checkFeeTvlExitVsEntry(exitPct, entryPct) === false  when exit >= entry
 * i.e. a freshly opened position would immediately fail its own exit rule
 * (open→close churn + fee burn).
 *
 * Historically that mismatch was only a console.warn inside validateStartup()
 * and worker.ts fired validateStartup() fire-and-forget, so the warning never
 * reached Telegram and the churn-prone config kept trading.
 *
 * This module consumes the predicate on the money path:
 *   - the scanner OPEN gate refuses NEW opens while the invariant is breached
 *     (unless ALLOW_CONFIG_INVARIANT_BREACH=true is set),
 *   - exactly ONE Telegram alert is emitted per process (latched),
 *   - existing positions' exits are NOT touched — this gate is only ever
 *     consulted on the open path (scanner / worker startup), never on close.
 *
 * checkFeeTvlExitVsEntry stays pure; this module is the side-effect layer.
 */
import { checkFeeTvlExitVsEntry } from './config-invariants'
import { LP_FEE_TVL_EXIT_THRESHOLD, MIN_FEE_TVL_RATIO_24H } from './strategy-config'
import { sendAlert } from '@/bot/alerter'

/** openBlockedReason returned by the scanner when new opens are refused. */
export const CONFIG_INVARIANT_BLOCK_REASON = 'config_invariant_breach'

/** Env var that turns the fail-closed gate into warn-and-proceed. Any value other than 'true' = fail-closed. */
export const ALLOW_CONFIG_INVARIANT_BREACH_ENV = 'ALLOW_CONFIG_INVARIANT_BREACH'

export type ConfigInvariantGate = {
  /** true when the invariant is satisfied (exit < entry). */
  ok: boolean
  /** true when the operator explicitly opted into the warn-and-proceed escape hatch. */
  allowBreach: boolean
  /** effective decision for the OPEN gate: ok || allowBreach. */
  openAllowed: boolean
  /** invariant-blocked reason, present only when openAllowed === false. */
  reason?: string
  /** LP_FEE_TVL_EXIT_THRESHOLD (percent). */
  exitPct: number
  /** MIN_FEE_TVL_RATIO_24H * 100 (percent). */
  entryPct: number
}

/** Escape hatch. Default "false" (fail-closed): only the exact string 'true'
 * opts in, matching the strict parsing style used elsewhere in this repo. */
export function isConfigInvariantBreachAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === null || env === undefined) return false
  return env[ALLOW_CONFIG_INVARIANT_BREACH_ENV] === 'true'
}

/**
 * Pure decision layer: no I/O, no logging, no mutation. Given the exit/entry
 * percentages and the env, decides whether new opens are allowed.
 *
 * Defaults are the SHIPPED config values, so the scanner/worker call it with
 * no arguments.
 */
export function evaluateConfigInvariantGate(
  exitPct: number = LP_FEE_TVL_EXIT_THRESHOLD,
  entryPct: number = MIN_FEE_TVL_RATIO_24H * 100,
  env: NodeJS.ProcessEnv = process.env,
): ConfigInvariantGate {
  const ok = checkFeeTvlExitVsEntry(exitPct, entryPct)
  const allowBreach = isConfigInvariantBreachAllowed(env)
  const openAllowed = ok || allowBreach
  return {
    ok,
    allowBreach,
    openAllowed,
    reason: openAllowed ? undefined : CONFIG_INVARIANT_BLOCK_REASON,
    exitPct,
    entryPct,
  }
}

// Process-wide latch so the breach alert is emitted at most once, no matter how
// many times the gate is consulted (worker startup + every scanner tick).
let breachAlertSent = false

/** Test-only: clear the once-per-process alert latch. */
export function resetConfigInvariantAlertForTests(): void {
  breachAlertSent = false
}

export type ConfigInvariantEnforcement = {
  gate: ConfigInvariantGate
  /** true when THIS call emitted the Telegram alert (at most once per process). */
  alertEmitted: boolean
}

/**
 * Consume the invariant at an open gate.
 *
 * - invariant ok            → proceed silently
 * - breached + escape hatch → console.warn and proceed
 * - breached + fail-closed  → refuse new opens (reason = config_invariant_breach)
 *                             and emit exactly ONE Telegram alert per process.
 */
export async function enforceConfigInvariantOpenGate(
  exitPct: number = LP_FEE_TVL_EXIT_THRESHOLD,
  entryPct: number = MIN_FEE_TVL_RATIO_24H * 100,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigInvariantEnforcement> {
  const gate = evaluateConfigInvariantGate(exitPct, entryPct, env)
  let alertEmitted = false

  if (!gate.ok) {
    if (gate.allowBreach) {
      console.warn(
        `[config-invariant] BREACH ALLOWED (${ALLOW_CONFIG_INVARIANT_BREACH_ENV}=true): ` +
        `LP_FEE_TVL_EXIT_THRESHOLD (${gate.exitPct}%) >= MIN_FEE_TVL_RATIO_24H*100 (${gate.entryPct}%) ` +
        `— new opens proceed anyway (escape hatch)`,
      )
    } else if (!breachAlertSent) {
      breachAlertSent = true
      alertEmitted = true
      console.error(
        `[config-invariant] FAIL-CLOSED: refusing NEW opens — ` +
        `LP_FEE_TVL_EXIT_THRESHOLD (${gate.exitPct}%) >= MIN_FEE_TVL_RATIO_24H*100 (${gate.entryPct}%)`,
      )
      await sendAlert({
        type: 'error',
        message:
          `CONFIG INVARIANT BREACH — new opens REFUSED.\n` +
          `LP_FEE_TVL_EXIT_THRESHOLD (${gate.exitPct}%) >= MIN_FEE_TVL_RATIO_24H*100 (${gate.entryPct}%) ` +
          `causes immediate open→close churn.\n` +
          `Fix the pair (exit < entry) or set ${ALLOW_CONFIG_INVARIANT_BREACH_ENV}=true to override.\n` +
          `Existing positions still exit normally.`,
      }).catch(() => {})
    }
  }

  return { gate, alertEmitted }
}
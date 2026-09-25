/**
 * lib/pm2-targets.ts
 *
 * Pure, unit-testable PM2 target selection for the Telegram control plane.
 *
 * The Telegram bot is the ONLY recovery channel that can issue `/start` without SSH.
 * So neither `/stop` nor `/reload` (restart) may ever target `meteoracle-telegram`:
 * killing or restarting the control plane would destroy the very process that could
 * bring the bot back, or strand a confirmation that races the restart.
 *
 * Targets are therefore worker-only for every action. Tests assert this invariant
 * directly (see tests/pm2-targets.test.ts) so no future edit can reintroduce the bug
 * where `/stop` kills `meteoracle-worker meteoracle-telegram`.
 */

export type Pm2Action = 'stop' | 'restart'

/**
 * Worker-only PM2 targets for the given action.
 *
 * `meteoracle-telegram` is deliberately never a target (see file header). A full
 * redeploy that must also restart Telegram is a documented ops step run from the host,
 * not a Telegram command.
 */
export function buildPm2Targets(action: Pm2Action): string[] {
  void action // action currently selects the same worker-only set; kept as a parameter
  // so the command construction stays single-source and future actions can differ.
  return ['meteoracle-worker']
}

/**
 * Build the full PM2 argv for an action: [action, ...targets].
 * e.g. buildPm2Argv('stop') === ['stop', 'meteoracle-worker'].
 */
export function buildPm2Argv(action: Pm2Action): string[] {
  return [action, ...buildPm2Targets(action)]
}
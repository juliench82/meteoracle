/**
 * bot/rugcheck-cache.ts
 *
 * Thin wrapper over lib/rugcheck.ts. lib/rugcheck.ts:83's -1 sentinel (plus its
 * 2-minute error cache) is INTENTIONALLY kept — a hard, silent -1→0 reject on
 * every API outage would stall the bot (all fresh tokens rejected).
 *
 * G7 circuit breaker: on a SUSTAINED outage (RUGCHECK_CIRCUIT_FAILURE_THRESHOLD
 * consecutive failures) the breaker OPENS and the wrapper goes fail-OPEN — it
 * returns RUGCHECK_OUTAGE_SCORE so candidates are still accepted (with a single
 * warning alert) instead of silently rejected. Transient failures below the
 * threshold keep the existing 0 reject. isDailyLossLimitHit (lib/circuit-breaker
 * .ts) is NOT used here — the daily-loss breaker stays a separate concern.
 */
import { checkRugscore } from '@/lib/rugcheck'
import { sendAlert } from '@/bot/alerter'

const FAILURE_THRESHOLD = Number(process.env.RUGCHECK_CIRCUIT_FAILURE_THRESHOLD) || 3
const OUTAGE_SCORE = Number(process.env.RUGCHECK_OUTAGE_SCORE) || 100
// RUGCHECK_CIRCUIT_COOLDOWN_MS (default 300000) is reserved for a future
// close-delay refinement; the thin slice closes the breaker on the first
// healthy response (reset-on-success), so no time-gated cooldown is wired.

export function getRugcheckCacheSize() { return 0; }

let consecutiveFailures = 0
let breakerOpen = false
let alertedThisOpen = false

export async function getRugscore(tokenAddress: string, _symbol?: string): Promise<number> {
  let score: number
  try {
    score = await checkRugscore(tokenAddress)
  } catch {
    score = -1
  }

  if (score >= 0) {
    // Healthy response — reset breaker state so the next outage can alert again.
    consecutiveFailures = 0
    breakerOpen = false
    alertedThisOpen = false
    return score
  }

  // score < 0 : lib/rugcheck.ts sentinel (-1) — API unavailable (cached error).
  consecutiveFailures++
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    breakerOpen = true
    if (!alertedThisOpen) {
      sendAlert({
        type: 'warning',
        message: `rugcheck API outage — accepting candidates with warning (circuit breaker OPEN) for ${tokenAddress}`,
      }).catch(() => {})
      alertedThisOpen = true
    }
    return OUTAGE_SCORE
  }

  // Transient failure below threshold — keep the existing hard-reject behaviour.
  return 0
}

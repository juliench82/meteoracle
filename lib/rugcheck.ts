import axios from 'axios'

/**
 * Fetches a rugcheck.xyz risk score for a Solana token.
 *
 * Scoring logic:
 *   score_normalised > 30 → safetyScore = 15 (risky)
 *   score_normalised ≤ 30 → safetyScore = max(0, 100 − raw/10)
 *
 * Returns 70 (neutral/unknown) on API failure — 50 maps to score band 30/100
 * and kills candidates that are otherwise strong. Unknown ≠ bad.
 */
export async function checkRugscore(mintAddress: string): Promise<number> {
  try {
    const res = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
      { timeout: 8_000 }
    )

    const raw        = res.data?.score
    const normalised = res.data?.score_normalised
    console.log(`[rugcheck] ${mintAddress} raw score: ${raw}, normalised: ${normalised}`)

    if (typeof raw === 'number' && typeof normalised === 'number') {
      const safetyScore = normalised > 30 ? 15 : Math.round(Math.max(0, 100 - (raw / 10)))
      return Math.min(100, Math.max(0, safetyScore))
    }

    if (typeof raw === 'number') {
      return raw > 1000 ? 0 : Math.round(Math.max(0, 100 - (raw / 10)))
    }

    return 70
  } catch {
    console.warn(`[rugcheck] score fetch failed for ${mintAddress}, defaulting to 70`)
    return 70
  }
}

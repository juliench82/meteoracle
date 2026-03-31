import axios from 'axios'

/**
 * Fetches a rugcheck.xyz risk score for a Solana token.
 *
 * The rugcheck API returns a RISK score where:
 *   low value  = safer token  (e.g. score=1  means very low risk)
 *   high value = riskier token (e.g. score=9000 means very high risk)
 *
 * We normalise to a 0–100 SAFETY score (100 = safest) by inverting:
 *   safetyScore = max(0, 100 - (rawScore / 100))
 *
 * Returns 50 (neutral) on API failure so we don't block the pipeline.
 */
export async function checkRugscore(mintAddress: string): Promise<number> {
  try {
    const res = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
      { timeout: 8_000 }
    )

    const raw = res.data?.score
    console.log(`[rugcheck] ${mintAddress} raw score: ${raw}`)

    if (typeof raw === 'number') {
      // Raw score is a risk score (higher = riskier).
      // Observed range: 1 (very safe) to ~10000+ (very risky).
      // Normalise: treat 0–1000 as the working range, invert to 0–100 safety.
      const safetyScore = Math.round(Math.max(0, 100 - (raw / 10)))
      return Math.min(100, Math.max(0, safetyScore))
    }

    return 50
  } catch {
    console.warn(`[rugcheck] score fetch failed for ${mintAddress}, defaulting to 50`)
    return 50
  }
}

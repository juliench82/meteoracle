import axios from 'axios'

/**
 * Fetches a rugcheck.xyz risk score for a Solana token.
 * Free API, no key required, no meaningful rate limit for our volume.
 *
 * Returns a normalised score 0–100 (100 = safest).
 * Returns 50 (neutral) on failure so we don't block the pipeline.
 */
export async function checkRugscore(mintAddress: string): Promise<number> {
  try {
    const res = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
      { timeout: 8_000 }
    )

    const score = res.data?.score
    if (typeof score === 'number') {
      // rugcheck returns 0 (risky) to 100 (safe)
      return Math.min(100, Math.max(0, score))
    }

    return 50 // neutral fallback
  } catch {
    console.warn(`[rugcheck] score fetch failed for ${mintAddress}, defaulting to 50`)
    return 50
  }
}

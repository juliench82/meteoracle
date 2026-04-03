import axios from 'axios'

/**
 * Fetches a rugcheck.xyz risk score for a Solana token.
 *
 * The API returns both:
 *   score            — raw risk score (higher = riskier, can exceed 10000)
 *   score_normalised — already a 0–100 safety-ish scale provided by rugcheck
 *
 * We prefer score_normalised when available.
 * Fallback: raw > 1000 → 0, else max(0, 100 − raw/10)
 *
 * Returns 50 (neutral) on API failure so we don’t block the pipeline.
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

    // Prefer the API’s own normalised score (0–100, lower = safer on their scale)
    // Their scale: 1 = very safe, 100 = very risky — invert to our safety scale
    if (typeof normalised === 'number') {
      return Math.min(100, Math.max(0, 100 - normalised))
    }

    if (typeof raw === 'number') {
      return raw > 1000 ? 0 : Math.round(Math.max(0, 100 - (raw / 10)))
    }

    return 50
  } catch {
    console.warn(`[rugcheck] score fetch failed for ${mintAddress}, defaulting to 50`)
    return 50
  }
}

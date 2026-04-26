import axios from 'axios'

/**
 * Fetches a rugcheck.xyz risk score for a Solana token.
 *
 * Meteoracle score = 100 - score_normalised
 *   rugcheck   0/100 (safe)    → Meteoracle 100
 *   rugcheck  34/100 (warning) → Meteoracle  66
 *   rugcheck  58/100 (warning) → Meteoracle  42
 *   rugcheck 100/100 (rugged)  → Meteoracle   0
 *
 * The public endpoint works without auth. No API key needed.
 */
export async function checkRugscore(mintAddress: string): Promise<number> {
  try {
    const res = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
      { timeout: 8_000 },
    )

    const raw        = res.data?.score
    const normalised = res.data?.score_normalised
    console.log(`[rugcheck] ${mintAddress} raw: ${raw}, normalised: ${normalised}`)

    if (typeof normalised === 'number') {
      return Math.min(100, Math.max(0, 100 - normalised))
    }

    if (typeof raw === 'number') {
      return raw > 10_000 ? 0 : Math.round(Math.max(0, 100 - (raw / 100)))
    }

    console.warn(`[rugcheck] ${mintAddress} — unexpected response shape, defaulting to 70`)
    return 70
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 429) {
      console.warn(`[rugcheck] ${mintAddress} — rate limited (429), defaulting to 70`)
    } else {
      console.warn(`[rugcheck] score fetch failed for ${mintAddress}, defaulting to 70`)
    }
    return 70
  }
}

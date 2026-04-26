import axios from 'axios'

const RUGCHECK_API_KEY = process.env.RUGCHECK_API_KEY ?? ''

/**
 * Fetches a rugcheck.xyz risk score for a Solana token.
 *
 * Meteoracle score = 100 - score_normalised
 *   rugcheck   0/100 (safe)    → Meteoracle 100
 *   rugcheck  34/100 (warning) → Meteoracle  66
 *   rugcheck 100/100 (rugged)  → Meteoracle   0
 *
 * Without RUGCHECK_API_KEY the public endpoint gets rate-limited
 * and all scores silently default to 70. Set the key.
 */
export async function checkRugscore(mintAddress: string): Promise<number> {
  if (!RUGCHECK_API_KEY) {
    console.warn('[rugcheck] No RUGCHECK_API_KEY set — all scores will default to 70')
    return 70
  }

  try {
    const res = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
      {
        timeout: 8_000,
        headers: { Authorization: `Bearer ${RUGCHECK_API_KEY}` },
      },
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

    console.warn(`[rugcheck] ${mintAddress} — unexpected response, defaulting to 70`)
    return 70
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 429) {
      console.warn(`[rugcheck] ${mintAddress} — rate limited (429). Check RUGCHECK_API_KEY.`)
    } else {
      console.warn(`[rugcheck] score fetch failed for ${mintAddress}, defaulting to 70`)
    }
    return 70
  }
}

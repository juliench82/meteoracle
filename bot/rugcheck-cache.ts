// Re-export real implementation (previous stub always returned 50, causing permissive gates)
import { checkRugscore } from '@/lib/rugcheck'

export function getRugcheckCacheSize() { return 0; }

export async function getRugscore(tokenAddress: string, _symbol?: string): Promise<number> {
  try {
    const score = await checkRugscore(tokenAddress)
    return score < 0 ? 50 : score // last-resort default only on hard failure
  } catch {
    return 50
  }
}

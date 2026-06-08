/**
 * Shared SOL price resolver (USD).
 * Uses DexScreener (free, reliable). Falls back to SOL_PRICE_USD env or 150.
 * Extracted so monitor (dry-sim PnL) and scanner can share without duplication/hardcoded 150.
 */

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens'

export async function resolveSolPriceUsd(): Promise<number> {
  try {
    const res = await fetch(`${DEXSCREENER}/So11111111111111111111111111111111111111112`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const json = await res.json() as any
      const pairs = json?.pairs || []
      // Prefer stable quote for accurate SOL price
      const solPair = pairs.find((p: any) =>
        (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT') &&
        p.chainId === 'solana'
      ) || pairs[0]
      const price = parseFloat(solPair?.priceUsd || '0')
      if (price > 0) return price
    }
  } catch {}
  const envSolPrice = parseFloat(process.env.SOL_PRICE_USD ?? '')
  return Number.isFinite(envSolPrice) && envSolPrice > 0 ? envSolPrice : 150
}

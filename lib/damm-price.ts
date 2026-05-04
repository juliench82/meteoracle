import { Connection, PublicKey } from '@solana/web3.js'

export const WSOL_MINT = 'So11111111111111111111111111111111111111112'

export type DammSolPrice = {
  solPerToken: number
  poolPrice: number
  tokenAMint: string
  tokenBMint: string
  tokenADecimals: number
  tokenBDecimals: number
}

const mintDecimalsCache = new Map<string, number | null>()

function toBase58(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58()
  if (value && typeof (value as { toBase58?: unknown }).toBase58 === 'function') {
    return (value as { toBase58: () => string }).toBase58()
  }
  return String(value ?? '')
}

function parseDecimalCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 18 ? n : null
}

async function fetchMintDecimals(connection: Connection, mint: PublicKey): Promise<number | null> {
  const mintString = mint.toBase58()
  if (mintString === WSOL_MINT) return 9
  if (mintDecimalsCache.has(mintString)) return mintDecimalsCache.get(mintString) ?? null

  try {
    const account = await connection.getParsedAccountInfo(mint, 'confirmed')
    const decimals = parseDecimalCount((account.value?.data as any)?.parsed?.info?.decimals)
    mintDecimalsCache.set(mintString, decimals)
    return decimals
  } catch {
    mintDecimalsCache.set(mintString, null)
    return null
  }
}

export async function getDammSolPriceFromPoolState(
  connection: Connection,
  poolState: {
    sqrtPrice: { toString: () => string }
    tokenAMint: PublicKey
    tokenBMint: PublicKey
  },
): Promise<DammSolPrice | null> {
  const tokenAMint = toBase58(poolState.tokenAMint)
  const tokenBMint = toBase58(poolState.tokenBMint)
  const tokenADecimals = await fetchMintDecimals(connection, poolState.tokenAMint)
  const tokenBDecimals = await fetchMintDecimals(connection, poolState.tokenBMint)
  if (tokenADecimals === null || tokenBDecimals === null) return null

  const mod = await import('@meteora-ag/cp-amm-sdk')
  const poolPrice = Number(
    mod.getPriceFromSqrtPrice(poolState.sqrtPrice as any, tokenADecimals, tokenBDecimals).toString(),
  )
  if (!Number.isFinite(poolPrice) || poolPrice <= 0) return null

  let solPerToken: number | null = null
  if (tokenAMint === WSOL_MINT && tokenBMint !== WSOL_MINT) {
    solPerToken = 1 / poolPrice
  } else if (tokenBMint === WSOL_MINT && tokenAMint !== WSOL_MINT) {
    solPerToken = poolPrice
  }

  if (solPerToken === null || !Number.isFinite(solPerToken) || solPerToken <= 0) return null

  return {
    solPerToken,
    poolPrice,
    tokenAMint,
    tokenBMint,
    tokenADecimals,
    tokenBDecimals,
  }
}

export function normalizeRawPoolPriceToSolPerToken(
  rawPoolPrice: number,
  price: Pick<DammSolPrice, 'tokenAMint' | 'tokenBMint' | 'tokenADecimals' | 'tokenBDecimals'>,
): number | null {
  if (!Number.isFinite(rawPoolPrice) || rawPoolPrice <= 0) return null

  const decimalPoolPrice = rawPoolPrice * 10 ** (price.tokenADecimals - price.tokenBDecimals)
  if (!Number.isFinite(decimalPoolPrice) || decimalPoolPrice <= 0) return null

  if (price.tokenAMint === WSOL_MINT && price.tokenBMint !== WSOL_MINT) return 1 / decimalPoolPrice
  if (price.tokenBMint === WSOL_MINT && price.tokenAMint !== WSOL_MINT) return decimalPoolPrice
  return null
}

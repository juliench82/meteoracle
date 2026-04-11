/**
 * pump.fun bonding curve reader — uses Helius RPC, no pump.fun API needed.
 *
 * BondingCurve account layout (Anchor, after 8-byte discriminator):
 *   offset  8: virtualTokenReserves  u64
 *   offset 16: virtualSolReserves    u64
 *   offset 24: realTokenReserves     u64
 *   offset 32: realSolReserves       u64
 *   offset 40: tokenTotalSupply      u64
 *   offset 48: complete              bool
 */

import axios from 'axios'

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'

const INITIAL_VIRTUAL_SOL_LAMPORTS    = 30_000_000_000
const GRADUATION_VIRTUAL_SOL_LAMPORTS = 115_000_000_000

export interface BondingCurveData {
  mintAddress: string
  bondingCurveAddress: string
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
  /** 0–100 */
  progressPct: number
}

export async function getBondingCurvePda(mintAddress: string): Promise<string> {
  const { PublicKey } = await import('@solana/web3.js')
  const mint    = new PublicKey(mintAddress)
  const program = new PublicKey(PUMP_PROGRAM_ID)
  const [pda]   = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    program
  )
  return pda.toBase58()
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function fetchBondingCurve(
  mintAddress: string,
  heliusRpcUrl: string,
  retries = 3,
  delayMs = 800
): Promise<BondingCurveData | null> {
  const bondingCurveAddress = await getBondingCurvePda(mintAddress)

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Small delay to avoid 429 after checkHolders which also hits Helius
      if (attempt > 1) await sleep(delayMs * attempt)

      const resp = await axios.post(
        heliusRpcUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [bondingCurveAddress, { encoding: 'base64' }],
        },
        { timeout: 8_000 }
      )

      const value = resp.data?.result?.value
      if (!value || !value.data?.[0]) return null

      const raw = Buffer.from(value.data[0], 'base64')
      if (raw.length < 49) return null

      const virtualTokenReserves = raw.readBigUInt64LE(8)
      const virtualSolReserves   = raw.readBigUInt64LE(16)
      const realTokenReserves    = raw.readBigUInt64LE(24)
      const realSolReserves      = raw.readBigUInt64LE(32)
      const tokenTotalSupply     = raw.readBigUInt64LE(40)
      const complete             = raw[48] === 1

      let progressPct: number
      if (complete) {
        progressPct = 100
      } else if (virtualSolReserves > BigInt(INITIAL_VIRTUAL_SOL_LAMPORTS)) {
        const num = Number(virtualSolReserves) - INITIAL_VIRTUAL_SOL_LAMPORTS
        const den = GRADUATION_VIRTUAL_SOL_LAMPORTS - INITIAL_VIRTUAL_SOL_LAMPORTS
        progressPct = Math.min(100, Math.max(0, (num / den) * 100))
      } else {
        progressPct = 0
      }

      return {
        mintAddress, bondingCurveAddress,
        virtualTokenReserves, virtualSolReserves,
        realTokenReserves, realSolReserves,
        tokenTotalSupply, complete, progressPct,
      }
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429 && attempt < retries) {
        console.warn(`[pumpfun] 429 for ${mintAddress}, retry ${attempt}/${retries} in ${delayMs * (attempt + 1)}ms`)
        await sleep(delayMs * (attempt + 1))
        continue
      }
      console.error(`[pumpfun] fetchBondingCurve failed for ${mintAddress} (attempt ${attempt}):`,
        err instanceof Error ? err.message : err)
      return null
    }
  }
  return null
}

export function isPumpFunToken(mintAddress: string): boolean {
  return mintAddress.toLowerCase().endsWith('pump')
}

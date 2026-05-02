import { Connection, PublicKey } from '@solana/web3.js'
import { createConnection, getConnection, getRpcEndpointCandidates, getWalletPublicKey } from '@/lib/solana'

export interface WalletTokenBalance {
  mint: string
  uiAmount: number
  decimals: number
}

export interface WalletLiveBalances {
  wallet: string
  sol: number
  tokens: WalletTokenBalance[]
}

async function fetchWalletLiveBalancesWithConnection(
  connection: Connection,
  walletPublicKey: PublicKey,
  mints: string[],
): Promise<WalletLiveBalances> {
  const solLamports = await connection.getBalance(walletPublicKey, 'confirmed')
  const uniqueMints = [...new Set(mints.filter(Boolean))]

  const tokens: WalletTokenBalance[] = []
  for (const mint of uniqueMints) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
        mint: new PublicKey(mint),
      })
      let uiAmount = 0
      let decimals = 0
      for (const account of accounts.value) {
        const amount = account.account.data.parsed?.info?.tokenAmount
        uiAmount += Number(amount?.uiAmount ?? 0)
        decimals = Number(amount?.decimals ?? decimals)
      }
      tokens.push({ mint, uiAmount, decimals })
    } catch (err) {
      console.warn(`[wallet-live] token balance fetch failed for ${mint}:`, err)
    }
  }

  return {
    wallet: walletPublicKey.toBase58(),
    sol: solLamports / 1e9,
    tokens,
  }
}

export async function fetchWalletLiveBalances(mints: string[] = []): Promise<WalletLiveBalances> {
  const walletPublicKey = getWalletPublicKey()
  const endpoints = getRpcEndpointCandidates({ includePublicFallback: true })
  let lastError: unknown = null

  for (const endpoint of endpoints) {
    try {
      return await fetchWalletLiveBalancesWithConnection(createConnection(endpoint), walletPublicKey, mints)
    } catch (err) {
      lastError = err
    }
  }

  if (endpoints.length === 0) {
    return fetchWalletLiveBalancesWithConnection(getConnection(), walletPublicKey, mints)
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'wallet balance fetch failed'))
}

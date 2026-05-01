import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'

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

export async function fetchWalletLiveBalances(mints: string[] = []): Promise<WalletLiveBalances> {
  const connection = getConnection()
  const wallet = getWallet()
  const solLamports = await connection.getBalance(wallet.publicKey, 'confirmed')
  const uniqueMints = [...new Set(mints.filter(Boolean))]

  const tokens: WalletTokenBalance[] = []
  for (const mint of uniqueMints) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
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
    wallet: wallet.publicKey.toBase58(),
    sol: solLamports / 1e9,
    tokens,
  }
}

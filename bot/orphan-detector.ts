import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { sendAlert } from '@/bot/alerter'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

/** Original: checks only pools already known to the DB. */
export async function detectOrphanedPositions(knownPoolAddresses: string[]): Promise<void> {
  const connection = getConnection()
  const wallet     = getWallet()
  const supabase   = createServerClient()
  const DLMM       = await getDLMM()

  console.log(`[orphan-detector] checking ${knownPoolAddresses.length} known pools for orphaned positions`)

  for (const poolAddress of knownPoolAddresses) {
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)

      for (const pos of userPositions) {
        const positionPubKey = pos.publicKey.toBase58()

        const { data: existing } = await supabase
          .from('lp_positions')
          .select('id')
          .eq('position_pubkey', positionPubKey)
          .limit(1)

        if (existing && existing.length > 0) continue

        console.warn(`[orphan-detector] ORPHAN found: ${positionPubKey} in pool ${poolAddress}`)

        const activeBin = await dlmmPool.getActiveBin()
        const { lowerBinId, upperBinId } = pos.positionData
        const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId

        await supabase.from('lp_positions').insert({
          symbol:          `ORPHAN-${positionPubKey.slice(0, 6)}`,
          token_address:   '',
          pool_address:    poolAddress,
          strategy_id:     'unknown',
          entry_price:     0,
          sol_deposited:   0,
          fees_earned_sol: 0,
          status:          'orphaned',
          in_range:        inRange,
          opened_at:       new Date().toISOString(),
          position_pubkey: positionPubKey,
          metadata:        { detectedBy: 'orphan-detector' },
        })

        await sendAlert({
          type: 'orphan_detected',
          symbol: `ORPHAN-${positionPubKey.slice(0, 6)}`,
          positionPubKey,
          poolAddress,
        })
      }
    } catch (err) {
      console.warn(`[orphan-detector] failed for pool ${poolAddress}:`, err)
    }
  }

  console.log('[orphan-detector] done')
}

/**
 * Full-wallet scan: fetches ALL onchain DLMM positions for this wallet
 * via getAllLbPairPositionsByUser, then reconciles each against the DB.
 * Catches positions opened outside the bot (manual, other tools).
 */
export async function detectAllOrphanedPositions(): Promise<void> {
  const connection = getConnection()
  const wallet     = getWallet()
  const supabase   = createServerClient()
  const DLMM       = await getDLMM()

  console.log('[orphan-detector] full-wallet scan for orphaned positions')

  let allPositions: Map<string, { publicKey: PublicKey; positionData: { lowerBinId: number; upperBinId: number } }>
  try {
    allPositions = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey)
  } catch (err) {
    console.warn('[orphan-detector] getAllLbPairPositionsByUser failed:', err)
    return
  }

  let found = 0
  for (const [poolAddress, positionInfo] of allPositions) {
    // positionInfo may be a single position object or wrapped — handle both shapes
    const positions: Array<{ publicKey: PublicKey; positionData: { lowerBinId: number; upperBinId: number } }> =
      Array.isArray((positionInfo as any).userPositions)
        ? (positionInfo as any).userPositions
        : [positionInfo]

    for (const pos of positions) {
      const positionPubKey = pos.publicKey.toBase58()

      const { data: existing } = await supabase
        .from('lp_positions')
        .select('id')
        .eq('position_pubkey', positionPubKey)
        .limit(1)

      if (existing && existing.length > 0) continue

      found++
      console.warn(`[orphan-detector] ORPHAN found: ${positionPubKey} in pool ${poolAddress}`)

      let inRange = false
      try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
        const activeBin = await dlmmPool.getActiveBin()
        const { lowerBinId, upperBinId } = pos.positionData
        inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId
      } catch { /* non-fatal — inRange stays false */ }

      await supabase.from('lp_positions').insert({
        symbol:          `ORPHAN-${positionPubKey.slice(0, 6)}`,
        token_address:   '',
        pool_address:    poolAddress,
        strategy_id:     'unknown',
        entry_price:     0,
        sol_deposited:   0,
        fees_earned_sol: 0,
        status:          'orphaned',
        in_range:        inRange,
        opened_at:       new Date().toISOString(),
        position_pubkey: positionPubKey,
        metadata:        { detectedBy: 'orphan-detector-auto' },
      })

      await sendAlert({
        type: 'orphan_detected',
        symbol: `ORPHAN-${positionPubKey.slice(0, 6)}`,
        positionPubKey,
        poolAddress,
      })
    }
  }

  console.log(`[orphan-detector] full-wallet scan done — orphans found: ${found}`)
}

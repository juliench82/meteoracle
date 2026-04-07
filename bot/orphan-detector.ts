import DLMM from '@meteora-ag/dlmm'
import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { sendAlert } from '@/bot/alerter'

/**
 * Scans the wallet's on-chain Meteora positions and cross-checks against Supabase.
 * Any position found on-chain but NOT in the DB is inserted as status='orphaned'
 * and alerted via Telegram so it can be manually reviewed or closed.
 *
 * Call this once at scanner startup.
 */
export async function detectOrphanedPositions(knownPoolAddresses: string[]): Promise<void> {
  const connection = getConnection()
  const wallet     = getWallet()
  const supabase   = createServerClient()

  console.log(`[orphan-detector] checking ${knownPoolAddresses.length} known pools for orphaned positions`)

  for (const poolAddress of knownPoolAddresses) {
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)

      for (const pos of userPositions) {
        const positionPubKey = pos.publicKey.toBase58()

        // Check if this on-chain position is already tracked in Supabase
        const { data: existing } = await supabase
          .from('positions')
          .select('id')
          .contains('metadata', { positionPubKey })
          .limit(1)

        if (existing && existing.length > 0) continue // already tracked

        // Orphan found — insert into DB and alert
        console.warn(`[orphan-detector] ORPHAN found: ${positionPubKey} in pool ${poolAddress}`)

        const activeBin = await dlmmPool.getActiveBin()
        const { lowerBinId, upperBinId } = pos.positionData
        const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId

        await supabase.from('positions').insert({
          token_symbol:  `ORPHAN-${positionPubKey.slice(0, 6)}`,
          token_address: '',
          pool_address:  poolAddress,
          strategy_id:   'unknown',
          entry_price:   0,
          sol_deposited: 0,
          fees_earned_sol: 0,
          status:        'orphaned',
          in_range:      inRange,
          opened_at:     new Date().toISOString(),
          metadata:      { positionPubKey, detectedBy: 'orphan-detector' },
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

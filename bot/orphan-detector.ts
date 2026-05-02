import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { sendAlert } from '@/bot/alerter'
import { syncAllMeteoraPositions, type MeteoraPositionSyncResult } from '@/lib/position-sync'
import { getSupabaseRestHeaders, getSupabaseUrl } from '@/lib/supabase'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

async function positionExistsInDb(positionPubKey: string): Promise<boolean> {
  const res = await fetch(
    `${getSupabaseUrl()}/rest/v1/lp_positions?position_pubkey=eq.${positionPubKey}&select=id&limit=1`,
    { headers: getSupabaseRestHeaders('representation'), signal: AbortSignal.timeout(8_000) },
  )
  if (!res.ok) throw new Error(`positionExistsInDb ${res.status}: ${await res.text()}`)
  const rows: unknown[] = await res.json()
  return rows.length > 0
}

/**
 * Resolves the token X mint from the DLMM pool. The pool's tokenX is the
 * non-SOL token (or tokenX when neither side is SOL). We use this as `mint`
 * because the lp_positions.mint column is NOT NULL and must be a real address.
 *
 * dlmmPool.tokenX.publicKey is populated synchronously after DLMM.create() —
 * no extra RPC call is needed.
 */
function resolveMintFromPool(
  dlmmPool: { tokenX: { publicKey: PublicKey }; tokenY: { publicKey: PublicKey } },
  poolAddress: string,
): string {
  const SOL_MINT = 'So11111111111111111111111111111111111111112'
  const x = dlmmPool.tokenX.publicKey.toBase58()
  const y = dlmmPool.tokenY.publicKey.toBase58()
  // Return whichever side is not native SOL. If neither is SOL, return tokenX.
  if (y === SOL_MINT) return x
  if (x === SOL_MINT) return y
  console.warn(`[orphan-detector] pool ${poolAddress}: neither token is SOL — using tokenX (${x}) as mint`)
  return x
}

async function insertOrphan(
  positionPubKey: string,
  poolAddress: string,
  mint: string,
  inRange: boolean,
): Promise<void> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/lp_positions`, {
    method: 'POST',
    headers: getSupabaseRestHeaders('minimal'),
    body: JSON.stringify({
      symbol:          `ORPHAN-${positionPubKey.slice(0, 6)}`,
      mint,
      pool_address:    poolAddress,
      strategy_id:     'unknown',
      entry_price:     0,
      entry_price_sol: 0,
      entry_price_usd: 0,
      sol_deposited:   0,
      token_amount:    0,
      claimable_fees_usd: 0,
      position_value_usd: 0,
      status:          inRange ? 'active' : 'out_of_range',
      in_range:        inRange,
      dry_run:         false,
      position_type:   'dlmm',
      opened_at:       new Date().toISOString(),
      position_pubkey: positionPubKey,
      metadata:        {
        detectedBy: 'orphan-detector-auto',
        source_of_truth: 'meteora',
        needs_strategy_review: true,
      },
    }),
    signal: AbortSignal.timeout(8_000),
  })
  // 409 = duplicate key — already inserted, not an error
  if (!res.ok && res.status !== 409) {
    throw new Error(`insertOrphan ${res.status}: ${await res.text()}`)
  }
}

// In-memory dedup: prevents repeat alerts for the same orphan across ticks
// within a single process lifetime. Cleared on restart.
const _alertedOrphans = new Set<string>()

/** Original: checks only pools already known to the DB. */
export async function detectOrphanedPositions(knownPoolAddresses: string[]): Promise<void> {
  const connection = getConnection()
  const wallet     = getWallet()
  const DLMM       = await getDLMM()

  console.log(`[orphan-detector] checking ${knownPoolAddresses.length} known pools for orphaned positions`)

  for (const poolAddress of knownPoolAddresses) {
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)

      for (const pos of userPositions) {
        const positionPubKey = pos.publicKey.toBase58()

        const exists = await positionExistsInDb(positionPubKey)
        if (exists) continue

        console.warn(`[orphan-detector] ORPHAN found: ${positionPubKey} in pool ${poolAddress}`)

        const activeBin = await dlmmPool.getActiveBin()
        const { lowerBinId, upperBinId } = pos.positionData
        const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId
        const mint = resolveMintFromPool(dlmmPool, poolAddress)

        await insertOrphan(positionPubKey, poolAddress, mint, inRange)

        if (!_alertedOrphans.has(positionPubKey)) {
          _alertedOrphans.add(positionPubKey)
          await sendAlert({
            type: 'orphan_detected',
            symbol: `ORPHAN-${positionPubKey.slice(0, 6)}`,
            positionPubKey,
            poolAddress,
            mint,
            positionType: 'dlmm',
          })
        }
      }
    } catch (err) {
      console.warn(`[orphan-detector] failed for pool ${poolAddress}:`, err)
    }
  }

  console.log('[orphan-detector] done')
}

/**
 * Full-wallet scan: fetches all on-chain Meteora LP positions for this wallet
 * (DLMM + DAMM), then reconciles each against the DB cache.
 * Catches positions opened outside the bot (manual, other tools).
 */
export async function detectAllOrphanedPositions(): Promise<MeteoraPositionSyncResult> {
  console.log('[orphan-detector] full-wallet scan for Meteora positions')

  const result = await syncAllMeteoraPositions()

  for (const live of result.insertedPositions) {
    const positionPubKey = live.position_pubkey
    console.warn(`[orphan-detector] live Meteora position missing from DB: ${positionPubKey} in pool ${live.pool_address}`)

    if (_alertedOrphans.has(positionPubKey)) {
      console.log(`[orphan-detector] ${positionPubKey} — alert already sent this session, skipping`)
      continue
    }

    _alertedOrphans.add(positionPubKey)
    await sendAlert({
      type: 'orphan_detected',
      symbol: live.symbol,
      positionPubKey,
      poolAddress: live.pool_address,
      mint: live.mint,
      positionType: live.position_type === 'damm-edge' ? 'damm-v2' : 'dlmm',
    })
  }

  console.log(
    `[orphan-detector] full-wallet scan done — live=${result.live} updated=${result.updated} inserted=${result.inserted} closed=${result.externallyClosed} ` +
    `(dlmm=${result.dlmmLive}, damm=${result.dammLive})`,
  )
  return result
}

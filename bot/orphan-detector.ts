import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { sendAlert } from '@/bot/alerter'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

function sbUrl(): string {
  const u = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!u) throw new Error('SUPABASE_URL not set')
  return u
}
function sbKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return k
}
function sbHeaders() {
  return {
    'apikey': sbKey(),
    'Authorization': `Bearer ${sbKey()}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  }
}

async function positionExistsInDb(positionPubKey: string): Promise<boolean> {
  const res = await fetch(
    `${sbUrl()}/rest/v1/lp_positions?position_pubkey=eq.${positionPubKey}&select=id&limit=1`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(8_000) },
  )
  if (!res.ok) throw new Error(`positionExistsInDb ${res.status}: ${await res.text()}`)
  const rows: unknown[] = await res.json()
  return rows.length > 0
}

async function insertOrphan(
  positionPubKey: string,
  poolAddress: string,
  inRange: boolean,
): Promise<void> {
  const res = await fetch(`${sbUrl()}/rest/v1/lp_positions`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      symbol:          `ORPHAN-${positionPubKey.slice(0, 6)}`,
      mint:            '',
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
    }),
    signal: AbortSignal.timeout(8_000),
  })
  // 409 = duplicate — already inserted, not an error
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

        await insertOrphan(positionPubKey, poolAddress, inRange)

        if (!_alertedOrphans.has(positionPubKey)) {
          _alertedOrphans.add(positionPubKey)
          await sendAlert({
            type: 'orphan_detected',
            symbol: `ORPHAN-${positionPubKey.slice(0, 6)}`,
            positionPubKey,
            poolAddress,
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
 * Full-wallet scan: fetches ALL onchain DLMM positions for this wallet
 * via getAllLbPairPositionsByUser, then reconciles each against the DB.
 * Catches positions opened outside the bot (manual, other tools).
 */
export async function detectAllOrphanedPositions(): Promise<void> {
  const connection = getConnection()
  const wallet     = getWallet()
  const DLMM       = await getDLMM()

  console.log('[orphan-detector] full-wallet scan for orphaned positions')

  let allPositions: Map<string, any>
  try {
    allPositions = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey)
  } catch (err) {
    console.warn('[orphan-detector] getAllLbPairPositionsByUser failed:', err)
    return
  }

  let found = 0
  for (const [poolAddress, positionInfo] of allPositions) {
    const positions: Array<{ publicKey: PublicKey; positionData: { lowerBinId: number; upperBinId: number } }> =
      Array.isArray((positionInfo as any).userPositions)
        ? (positionInfo as any).userPositions
        : [positionInfo]

    for (const pos of positions) {
      const positionPubKey = pos.publicKey.toBase58()

      let exists: boolean
      try {
        exists = await positionExistsInDb(positionPubKey)
      } catch (err) {
        console.warn(`[orphan-detector] DB check failed for ${positionPubKey} — skipping:`, err)
        continue
      }
      if (exists) continue

      found++
      console.warn(`[orphan-detector] ORPHAN found: ${positionPubKey} in pool ${poolAddress}`)

      let inRange = false
      try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
        const activeBin = await dlmmPool.getActiveBin()
        const { lowerBinId, upperBinId } = pos.positionData
        inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId
      } catch { /* non-fatal — inRange stays false */ }

      try {
        await insertOrphan(positionPubKey, poolAddress, inRange)
      } catch (err) {
        console.error(`[orphan-detector] insertOrphan failed for ${positionPubKey}:`, err)
        continue
      }

      if (!_alertedOrphans.has(positionPubKey)) {
        _alertedOrphans.add(positionPubKey)
        await sendAlert({
          type: 'orphan_detected',
          symbol: `ORPHAN-${positionPubKey.slice(0, 6)}`,
          positionPubKey,
          poolAddress,
        })
      } else {
        console.log(`[orphan-detector] ${positionPubKey} — alert already sent this session, skipping`)
      }
    }
  }

  console.log(`[orphan-detector] full-wallet scan done — orphans found: ${found}`)
}

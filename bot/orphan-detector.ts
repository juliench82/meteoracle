import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { sendAlert } from '@/bot/alerter'
import { fetchLiveDlmmPositions, type LiveDlmmPosition } from '@/lib/meteora-live'

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
  const res = await fetch(`${sbUrl()}/rest/v1/lp_positions`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
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

async function insertLivePosition(live: LiveDlmmPosition): Promise<void> {
  const res = await fetch(`${sbUrl()}/rest/v1/lp_positions`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      symbol:              live.symbol,
      mint:                live.mint,
      pool_address:        live.pool_address,
      strategy_id:         'meteora-live',
      entry_price:         0,
      entry_price_sol:     0,
      entry_price_usd:     0,
      current_price:       live.current_price,
      sol_deposited:       live.sol_deposited,
      token_amount:        live.token_amount,
      claimable_fees_usd:  0,
      position_value_usd:  0,
      status:              live.status,
      in_range:            live.in_range,
      dry_run:             false,
      position_type:       'dlmm',
      opened_at:           live.opened_at,
      position_pubkey:     live.position_pubkey,
      metadata: {
        ...live.metadata,
        source_of_truth: 'meteora',
        detectedBy: 'wallet-position-scan',
        needs_strategy_review: true,
      },
    }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok && res.status !== 409) {
    throw new Error(`insertLivePosition ${res.status}: ${await res.text()}`)
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
export async function detectAllOrphanedPositions(): Promise<{ live: number; inserted: number }> {
  console.log('[orphan-detector] full-wallet scan for orphaned positions')

  let livePositions: LiveDlmmPosition[]
  try {
    livePositions = await fetchLiveDlmmPositions()
  } catch (err) {
    console.warn('[orphan-detector] fetchLiveDlmmPositions failed:', err)
    return { live: 0, inserted: 0 }
  }

  let inserted = 0
  for (const live of livePositions) {
    const positionPubKey = live.position_pubkey

    let exists: boolean
    try {
      exists = await positionExistsInDb(positionPubKey)
    } catch (err) {
      console.warn(`[orphan-detector] DB check failed for ${positionPubKey} — skipping:`, err)
      continue
    }
    if (exists) continue

    console.warn(`[orphan-detector] live Meteora position missing from DB: ${positionPubKey} in pool ${live.pool_address}`)

    try {
      await insertLivePosition(live)
      inserted++
    } catch (err) {
      console.error(`[orphan-detector] insertLivePosition failed for ${positionPubKey}:`, err)
      continue
    }

    if (!_alertedOrphans.has(positionPubKey)) {
      _alertedOrphans.add(positionPubKey)
      await sendAlert({
        type: 'orphan_detected',
        symbol: live.symbol,
        positionPubKey,
        poolAddress: live.pool_address,
      })
    } else {
      console.log(`[orphan-detector] ${positionPubKey} — alert already sent this session, skipping`)
    }
  }

  console.log(`[orphan-detector] full-wallet scan done — live=${livePositions.length} inserted=${inserted}`)
  return { live: livePositions.length, inserted }
}

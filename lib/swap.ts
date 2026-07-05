import { Connection, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import * as fs from 'fs'
import * as path from 'path'
import { getConnection, getWallet } from '@/lib/solana'
import { sendAlert } from '@/bot/alerter'
import { getOpenLpPositions, saveOpenLpPositions, applyMonitorUpdates } from '@/lib/local-state'
import { atomicWriteJson } from './atomic-write'
import { envNumber } from '@/lib/strategy-config'
import { resolveSolPriceUsd } from '@/lib/sol-price'

// Note: main paths use direct Meteora DLMM swaps (see swapSolToTokenDirectOnDlmm in open.ts and retryStrandedSells here).
// Legacy Jupiter helpers have been removed. Only retryStrandedSells + getWalletTokenBalance remain.

const STATE_DIR = path.join(process.cwd(), 'state')
const STRANDED_BACKOFF_FILE = path.join(STATE_DIR, 'stranded-sell-backoff.json')
const STRANDED_SKIP_FILE = path.join(STATE_DIR, 'stranded-skip.json')

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
}

function loadStrandedBackoff(): Map<string, number> {
  try {
    ensureStateDir()
    if (fs.existsSync(STRANDED_BACKOFF_FILE)) {
      const data = JSON.parse(fs.readFileSync(STRANDED_BACKOFF_FILE, 'utf8'))
      if (data && typeof data === 'object') {
        return new Map(Object.entries(data).map(([k, v]) => [k, Number(v) || 0]))
      }
    }
  } catch {}
  return new Map()
}

function saveStrandedBackoff(map: Map<string, number>) {
  try {
    ensureStateDir()
    const obj: Record<string, number> = {}
    for (const [k, v] of map) obj[k] = v
    atomicWriteJson(STRANDED_BACKOFF_FILE, obj)
  } catch {}
}

function loadStrandedSkipList(): Set<string> {
  try {
    ensureStateDir()
    if (fs.existsSync(STRANDED_SKIP_FILE)) {
      const data = JSON.parse(fs.readFileSync(STRANDED_SKIP_FILE, 'utf8'))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch {}
  return new Set()
}

function saveStrandedSkipList(set: Set<string>) {
  try {
    ensureStateDir()
    atomicWriteJson(STRANDED_SKIP_FILE, Array.from(set))
  } catch {}
}



async function getTokenBalance(connection: Connection, mint: string, owner: PublicKey): Promise<bigint> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
  if (!accounts.value.length) return 0n
  const amount = accounts.value[0].account.data.parsed.info.tokenAmount.amount as string
  return BigInt(amount)
}

/** Public helper for stranded recovery (and any other wallet balance checks). */
export async function getWalletTokenBalance(mint: string): Promise<bigint> {
  const connection = getConnection()
  const wallet = getWallet()
  return getTokenBalance(connection, mint, wallet.publicKey)
}






/**
 * Retries stranded sell_failed positions (and any recently closed positions that
 * still have a token balance in the wallet).
 *
 * Called at the top of every monitor tick (via monitor.ts).
 * Uses only local state + direct wallet balance query + direct Meteora DLMM swap.
 * Pure direct path — no Jupiter or other fallbacks.
 * On successful recovery: updates the position record (status -> closed if needed,
 * records recovered timestamp/sig). Failures are left for the next tick.
 */
export async function retryStrandedSells(): Promise<{ retried: number; recovered: number }> {
  let positions = getOpenLpPositions()
  const now = Date.now()
  const recentMs = 7 * 24 * 3600 * 1000
  const pruneMs = 90 * 24 * 3600 * 1000 // prune very old closed to keep state file small

  // Light prune of ancient closed records (prevents unbounded growth)
  const beforePrune = positions.length
  positions = positions.filter((p: any) => {
    if (p.status !== 'closed') return true
    const closedTs = p.closed_at ? new Date(p.closed_at).getTime() : 0
    return (now - closedTs) < pruneMs
  })
  if (positions.length !== beforePrune) {
    saveOpenLpPositions(positions)
  }

  // Persisted backoff (survives restart) for tokens failing liquidity.
  const backoff: Map<string, number> = loadStrandedBackoff()
  const skipList: Set<string> = loadStrandedSkipList()
  const LIQUIDITY_BACKOFF_MS = 5 * 60 * 1000 // 5 minutes after a liquidity failure
  const MAX_STRANDED_AGE_DAYS = 2
  const MAX_STRANDED_AGE_MIN = MAX_STRANDED_AGE_DAYS * 24 * 60

  if (!(globalThis as any).__strandedSellAlerted) {
    (globalThis as any).__strandedSellAlerted = new Set<string>()
  }
  const alerted: Set<string> = (globalThis as any).__strandedSellAlerted

  let retried = 0
  let recovered = 0
  let longStranded = 0

  for (const pos of positions) {
    const recoveryMint: string = (pos as any).stranded_token_mint || pos.mint || '';
    if (!recoveryMint) continue;

    if (skipList.has(recoveryMint)) continue // permanently abandoned

    const tsStr = (pos as any).closed_at || (pos as any).opened_at
    let ts: number | undefined
    if (tsStr) {
      ts = new Date(tsStr).getTime()
      if (now - ts > recentMs) continue
    }
    if (pos.status === 'active' || pos.status === 'open') continue

    const isSellFailed = pos.status === 'sell_failed'
    const isRecentClosed = pos.status === 'closed' && !(pos as any).stranded_recovered_at

    if (!isSellFailed && !isRecentClosed) continue

    const sellFailedAt = (pos as any).sell_failed_at ? new Date((pos as any).sell_failed_at).getTime() : (ts ? new Date(tsStr).getTime() : now)
    const strandedAgeMin = Math.max(0, (now - sellFailedAt) / 60000)

    if (strandedAgeMin > MAX_STRANDED_AGE_MIN) {
      // Hard cutoff: give up after 2 days, persist skip list
      skipList.add(recoveryMint)
      saveStrandedSkipList(skipList)
      const sym = (pos as any).symbol || recoveryMint.slice(0, 6)
      console.warn(`[swap] ABANDONING stranded sell for ${sym} after ${MAX_STRANDED_AGE_DAYS}d — token likely illiquid.`)
      sendAlert({
        type: 'warning',
        message: `⚠️ Abandoning stranded sell for ${sym} after ${MAX_STRANDED_AGE_DAYS}d — token likely illiquid. Manual recovery needed.`,
      }).catch(() => {})
      continue
    }

    if (strandedAgeMin > 30 && !alerted.has(recoveryMint)) {
      longStranded++
      const sym = (pos as any).symbol || recoveryMint.slice(0, 6)
      console.warn(`[swap] LONG STRANDED SELL: ${sym} mint=${recoveryMint} age=${Math.round(strandedAgeMin)}m — no max-retry cutoff; will keep trying with backoff.`)
      sendAlert({
        type: 'warning',
        message: `⚠️ Stranded sell for ${sym} still holding token after ~${Math.round(strandedAgeMin)}m (may be illiquid). Monitor will keep retrying.`,
      }).catch(() => {})
      alerted.add(recoveryMint)
    }

    // Backoff check
    const lastFail = backoff.get(recoveryMint) || 0
    if (now - lastFail < LIQUIDITY_BACKOFF_MS) {
      continue
    }

    try {
      const bal = await getWalletTokenBalance(recoveryMint)
      if (bal > 0n) {
        retried++
        const sym = (pos as any).symbol || recoveryMint.slice(0, 6)
        const label = `[stranded-sell-retry][${sym}]`
        console.log(`${label} stranded balance=${bal} for ${recoveryMint} (status=${pos.status}) — recovering via direct DLMM`)

        // Direct DLMM sell for stranded recovery (no fallbacks)
        let recoveredSig: string | undefined
        try {
          const mod = await import('@meteora-ag/dlmm')
          const DLMM = mod.default as any
          const poolAddr = (pos as any).pool_address || (pos as any).metadata?.pool_address
          if (poolAddr) {
            const connection = getConnection()
            const wallet = getWallet()
            const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddr))
            const isTokenX = dlmmPool.tokenX.publicKey.toBase58() === recoveryMint
            const inToken = isTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey
            const outToken = isTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey
            const binArrays = await dlmmPool.getBinArrays()
            console.log(`${label} [direct-dlmm-recovery] fetched ${binArrays.length} bin arrays for stranded sell quote (pool=${poolAddr}; passing FULL list to swap)`);
            const swapYtoX = (inToken.toBase58() === dlmmPool.tokenY.publicKey.toBase58())
            const currentBal = await getWalletTokenBalance(recoveryMint)
            if (currentBal > 0n) {
              const inputAmountBN = new BN(currentBal.toString())
              // For recovery, use moderately loose 20% for quote to get a sensible minOut, then use it (or div4 fallback).
              const swapQuote = await dlmmPool.swapQuote(inputAmountBN, swapYtoX, new BN(2000), binArrays)
              const q = swapQuote as any
              if (!q.outAmount.isZero()) {
                const quotedIn = q.inAmount ?? inputAmountBN;
                console.log(`${label} [direct-dlmm-recovery] quote: in=${quotedIn} out=${q.outAmount}`);
                const binArrayKeysForSwap = (q.binArraysPubkey && q.binArraysPubkey.length > 0)
                  ? q.binArraysPubkey
                  : binArrays.slice(0, 3).map((ba: any) => ba.publicKey);
                console.log(`${label} [direct-dlmm-recovery] calling swap with limited ${binArrayKeysForSwap.length} bin array pubkeys`);

                const minOutBN = (q.minOutAmount && !q.minOutAmount.isZero()) ? q.minOutAmount : q.outAmount.div(new BN(4))

                // USD floor check to avoid burning capital on illiquid pools at low recovery (e.g. 25%)
                try {
                  const solPrice = await resolveSolPriceUsd().catch(() => 150)
                  const minOutSol = Number(minOutBN.toString()) / 1e9
                  const recoveryUsd = minOutSol * solPrice
                  const origSol = Number((pos as any).sol_deposited || 0)
                  const minRecoveryPct = envNumber('STRANDED_MIN_RECOVERY_PCT', 50)
                  const floorUsd = origSol * solPrice * (minRecoveryPct / 100)
                  if (recoveryUsd < floorUsd && origSol > 0) {
                    console.warn(`${label} recovery below floor ${minRecoveryPct}% (est $${recoveryUsd.toFixed(2)} < $${floorUsd.toFixed(2)}) — skipping this tick, backoff set`)
                    sendAlert({ type: 'warning', message: `⚠️ Stranded sell for ${sym} est recovery $${recoveryUsd.toFixed(2)} below ${minRecoveryPct}% floor (orig $${(origSol * solPrice).toFixed(2)}) — skipping` }).catch(() => {})
                    backoff.set(recoveryMint, now)
                    saveStrandedBackoff(backoff)
                    continue
                  }
                } catch (floorErr) {
                  console.warn(`${label} floor check error (proceeding):`, floorErr)
                }

                const swapTx = await dlmmPool.swap({
                  inToken,
                  binArraysPubkey: binArrayKeysForSwap,
                  inAmount: inputAmountBN,
                  lbPair: dlmmPool.pubkey,
                  user: wallet.publicKey,
                  minOutAmount: minOutBN,
                  outToken,
                })
                const { sendLegacyTx, applyPriorityFee } = await import('@/lib/solana-tx')
                const prepared = applyPriorityFee(swapTx, 100000)
                recoveredSig = await sendLegacyTx(prepared, [wallet], label)
                console.log(`${label} direct DLMM stranded sell confirmed ✔ sig: ${recoveredSig}`)
                recovered++
                console.log(`${label} recovered ✔ sig=${recoveredSig}`)
                // update state via safe merge to avoid race with monitor's applyMonitorUpdates
                const nowIso = new Date().toISOString()
                await applyMonitorUpdates([{
                  id: pos.id,
                  patch: {
                    stranded_recovered_at: nowIso,
                    stranded_recovered_sig: recoveredSig,
                    ...(pos.status === 'sell_failed' ? { status: 'closed' } : {})
                  }
                }])
                // clear backoff on success
                backoff.delete(recoveryMint)
                saveStrandedBackoff(backoff)
              }
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`${label} direct DLMM stranded sell failed, will retry next monitor tick: ${msg}`)
          if (msg.includes('Insufficient liquidity') || msg.includes('SWAP_QUOTE_INSUFFICIENT')) {
            backoff.set(recoveryMint, now)
            saveStrandedBackoff(backoff)
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const sym = (pos as any).symbol || pos.mint.slice(0, 6)
      console.warn(`[swap] stranded retry failed for ${sym}: ${msg}`)
    }
  }

  if (retried > 0 || longStranded > 0) {
    console.log(`[swap] stranded sells tick summary: retried=${retried} recovered=${recovered} longStrandedWarned=${longStranded}`)
  }
  return { retried, recovered }
}

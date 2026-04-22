import 'dotenv/config'
import { Keypair, PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { sendAlert } from '@/bot/alerter'

const PRE_GRAD_CLOSE_AFTER_MIN = parseInt(process.env.PRE_GRAD_CLOSE_AFTER_MIN ?? '45')

async function getCpAmm() {
  // TODO: replace with actual Raydium/cpAmm SDK import once removeLiquidity signature confirmed
  const mod = await import('@raydium-io/raydium-sdk-v2').catch(() => null)
  return mod
}

export async function closePreGradPosition(positionId: string): Promise<boolean> {
  const supabase = createServerClient()
  const label = `[pre-grad][close][${positionId}]`

  const { data: position, error } = await supabase
    .from('pre_grad_positions')
    .select('*')
    .eq('id', positionId)
    .single()

  if (error || !position) {
    console.error(`${label} position not found`)
    return false
  }

  const openedAt = new Date(position.opened_at).getTime()
  const ageMin = (Date.now() - openedAt) / 60_000

  // 45-min gate protects the hot path — do not remove
  if (ageMin < PRE_GRAD_CLOSE_AFTER_MIN) {
    console.log(`${label} too young (${ageMin.toFixed(1)}min < ${PRE_GRAD_CLOSE_AFTER_MIN}min) — skipping`)
    return false
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const cpAmmMod = await getCpAmm()

    if (!cpAmmMod) {
      console.warn(`${label} cpAmm SDK not available — marking closed without on-chain tx`)
      await supabase
        .from('pre_grad_positions')
        .update({ status: 'closed', closed_at: new Date().toISOString(), close_reason: 'sdk_unavailable' })
        .eq('id', positionId)
      return true
    }

    // positionNft must be a freshly generated Keypair().publicKey per SDK docs — NOT SystemProgram.programId
    const positionNft = new Keypair().publicKey
    console.log(`${label} positionNft=${positionNft.toBase58()} poolAddress=${position.pool_address}`)

    // TODO: Replace stub below once removeLiquidity signature is confirmed.
    // SDK expects positionPubkey (PublicKey) + owner (PublicKey), NOT { poolAddress, wallet }.
    // await cpAmmMod.removeLiquidity({
    //   positionPubkey: new PublicKey(position.position_pubkey),
    //   owner: wallet.publicKey,
    //   positionNft,
    // })
    console.warn(`${label} removeLiquidity stubbed — on-chain close skipped, marking DB closed`)

    await supabase
      .from('pre_grad_positions')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        close_reason: 'pre_grad_close_stub',
      })
      .eq('id', positionId)

    await sendAlert({
      type: 'pre_grad_closed',
      symbol: position.symbol,
      positionId,
      ageMin: Math.round(ageMin),
      reason: 'pre_grad_close_stub',
    })

    return true
  } catch (err) {
    console.error(`${label} close failed:`, err)
    await supabase.from('bot_logs').insert({
      level: 'error',
      event: 'pre_grad_close_failed',
      payload: { positionId, error: err instanceof Error ? err.message : String(err) },
    })
    return false
  }
}

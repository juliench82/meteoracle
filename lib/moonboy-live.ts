import { createServerClient } from '@/lib/supabase'

export interface MoonboyLivePosition {
  id: string
  mint: string
  symbol: string
  entry_price_usd: number
  token_amount: string
  sol_spent: number
  opened_at: string
  dry_run: boolean
  current_price_usd: number | null   // live from Jupiter
  pnl_pct: number | null             // computed live
  age_hours: number
  take_profit_pct: number | null
  stop_loss_pct: number | null
}

const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2'

async function fetchJupiterPrices(mints: string[]): Promise<Record<string, number>> {
  if (!mints.length) return {}
  try {
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${mints.join(',')}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return {}
    const data = await res.json()
    const result: Record<string, number> = {}
    for (const mint of mints) {
      const price = data?.data?.[mint]?.price
      if (typeof price === 'number' && price > 0) result[mint] = price
    }
    return result
  } catch {
    return {}
  }
}

export async function fetchMoonboyLivePositions(): Promise<MoonboyLivePosition[]> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('moonboy_positions')
    .select('id,mint,symbol,entry_price_usd,token_amount,sol_spent,opened_at,dry_run,metadata')
    .eq('status', 'open')
    .order('opened_at', { ascending: false })

  if (error || !data?.length) return []

  const mints = data.map((r) => r.mint)
  const prices = await fetchJupiterPrices(mints)

  const now = Date.now()
  return data.map((r) => {
    const entry = r.entry_price_usd ?? 0
    const live = prices[r.mint] ?? null
    const pnl_pct =
      live !== null && entry > 0
        ? Math.round(((live - entry) / entry) * 10_000) / 100
        : null
    const age_hours =
      Math.round(((now - new Date(r.opened_at).getTime()) / 3_600_000) * 10) / 10
    return {
      id: r.id,
      mint: r.mint,
      symbol: r.symbol,
      entry_price_usd: entry,
      token_amount: r.token_amount,
      sol_spent: r.sol_spent,
      opened_at: r.opened_at,
      dry_run: r.dry_run,
      current_price_usd: live,
      pnl_pct,
      age_hours,
      take_profit_pct: r.metadata?.take_profit_pct ?? null,
      stop_loss_pct:   r.metadata?.stop_loss_pct   ?? null,
    }
  })
}

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20'), 100)
  const strategy = searchParams.get('strategy')

  const supabase = createServerClient()

  let query = supabase
    .from('candidates')
    .select('*')
    .order('scanned_at', { ascending: false })
    .limit(limit)

  if (strategy) {
    query = query.eq('strategy_matched', strategy)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ candidates: data ?? [] })
}

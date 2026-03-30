import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? 'active'
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100)

  const supabase = createServerClient()

  let query = supabase
    .from('positions')
    .select('*')
    .order('opened_at', { ascending: false })
    .limit(limit)

  if (status !== 'all') {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ positions: data ?? [] })
}

import { NextResponse } from 'next/server'
import { STRATEGIES } from '@/strategies'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ strategies: STRATEGIES })
}

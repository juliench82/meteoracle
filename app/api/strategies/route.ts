import { NextResponse } from 'next/server'
import { STRATEGIES } from '@/strategies'

export async function GET() {
  return NextResponse.json({ strategies: STRATEGIES })
}

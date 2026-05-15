import { NextResponse } from 'next/server'
import { getDashboardData } from '@/lib/get-dashboard-data'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const data = await getDashboardData()

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=45, stale-while-revalidate=90',
      },
    })
  } catch (err) {
    console.error('[dashboard-data] failed:', err)
    return NextResponse.json(
      { error: 'Failed to load dashboard data' },
      { status: 500 }
    )
  }
}

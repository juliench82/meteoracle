import { NextResponse } from 'next/server'

// TODO: wire to Supabase in feat/scanner branch
export async function GET() {
  const mockPositions = [
    {
      id: '1',
      tokenSymbol: 'BONK',
      tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      poolAddress: '...',
      strategyId: 'evil-panda',
      binRangeLower: 0.000018,
      binRangeUpper: 0.000026,
      entryPrice: 0.000022,
      currentPrice: 0.000021,
      solDeposited: 0.5,
      feesEarnedSol: 0.012,
      status: 'active',
      inRange: true,
      openedAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ]
  return NextResponse.json({ positions: mockPositions })
}

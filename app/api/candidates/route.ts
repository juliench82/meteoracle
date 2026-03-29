import { NextResponse } from 'next/server'

// TODO: wire to Supabase in feat/scanner branch
export async function GET() {
  const mockCandidates = [
    {
      id: '1',
      tokenAddress: 'mock...',
      symbol: 'PEPE2',
      score: 87,
      strategyMatched: 'evil-panda',
      mcAtScan: 450000,
      volume24h: 1200000,
      holderCount: 3200,
      scannedAt: new Date().toISOString(),
    },
  ]
  return NextResponse.json({ candidates: mockCandidates })
}

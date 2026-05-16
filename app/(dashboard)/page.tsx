'use client'

import { useState, useEffect } from 'react'
import { DashboardClient } from '@/components/dashboard/DashboardClient'
import { RetroLogo } from '@/components/dashboard/RetroLogo'
import { SynthwavePepe } from '@/components/dashboard/SynthwavePepe'

export default function DashboardPage() {
  const [data, setData] = useState<any>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)

  const fetchData = async () => {
    setIsRefreshing(true)
    try {
      const res = await fetch('/api/dashboard-data', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      setLastFetch(new Date())
    } catch (err) {
      console.error('Failed to refresh dashboard', err)
    } finally {
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60_000)
    return () => clearInterval(interval)
  }, [])

  // Compute overall PnL status for Pepe's laser eyes
  const realizedPnl = data?.portfolio?.cachedHistory?.realizedPnlUsd ?? 0
  const livePnl = data?.portfolio?.totalPnlUsd ?? 0
  const totalPnl = realizedPnl + livePnl

  const pepeLaser: 'green' | 'red' | 'neutral' =
    totalPnl > 50 ? 'green' : totalPnl < -20 ? 'red' : 'neutral'

  if (!data) {
    return (
      <div className="p-6 text-zinc-400 text-sm">
        {isRefreshing ? 'Loading dashboard…' : 'No data yet.'}
      </div>
    )
  }

  return (
    <div className="dashboard-container min-h-screen">
      {/* Ultra Retro Header */}
      <div className="border-b-2 border-retro-border bg-retro-surface px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <RetroLogo />
          {/* Synthwave Pepe Mascot */}
          <div className="mt-1">
            <SynthwavePepe laser={pepeLaser} />
          </div>
        </div>

        <div className="flex items-center gap-5">
          {lastFetch && (
            <div className="font-mono text-xs text-retro-text-dim tracking-widest">
              LAST SYNC: {lastFetch.toLocaleTimeString()}
            </div>
          )}
          <button
            onClick={fetchData}
            disabled={isRefreshing}
            className="retro-btn font-mono tracking-widest"
          >
            {isRefreshing ? 'SYNCING...' : 'PRESS START TO REFRESH'}
          </button>
        </div>
      </div>

      <DashboardClient initialData={data} />
    </div>
  )
}

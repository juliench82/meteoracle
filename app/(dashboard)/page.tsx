'use client'

import { useState, useEffect } from 'react'
import { DashboardClient } from '@/components/dashboard/DashboardClient'
import { RetroLogo } from '@/components/dashboard/RetroLogo'

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
        <RetroLogo />

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

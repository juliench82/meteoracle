'use client'

import { useState, useEffect } from 'react'
import { DashboardClient } from '@/components/dashboard/DashboardClient'

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

  // Initial load
  useEffect(() => { fetchData() }, [])

  if (!data) {
    return (
      <div className="p-6 text-zinc-400 text-sm">
        {isRefreshing ? 'Loading dashboard…' : 'No data yet.'}
      </div>
    )
  }

  return (
    <div>
      <div className="flex justify-between items-center px-6 pt-6 mb-2">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <div className="flex items-center gap-3">
          {lastFetch && (
            <span className="text-xs text-zinc-500">
              Updated {lastFetch.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchData}
            disabled={isRefreshing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white disabled:opacity-50 transition-colors"
          >
            {isRefreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>
      <DashboardClient initialData={data} />
    </div>
  )
}

'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Invisible client component that triggers a full server-side re-render
 * of the dashboard at a fixed interval by calling router.refresh().
 * This re-fetches all Supabase data (positions, logs, candidates, KPIs)
 * without a full browser page reload.
 */
export function DashboardRefresher({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter()

  useEffect(() => {
    const id = setInterval(() => {
      router.refresh()
    }, intervalMs)
    return () => clearInterval(id)
  }, [router, intervalMs])

  return null
}

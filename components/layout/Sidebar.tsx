'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart2, BookOpen } from 'lucide-react'

const nav = [
  { href: '/',           icon: BarChart2, label: 'Dashboard' },
  { href: '/strategies', icon: BookOpen,  label: 'Strategies' },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="w-56 flex-shrink-0 bg-surface-elevated border-r border-surface-border flex flex-col">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-surface-border">
        <span className="text-brand text-2xl">⚡</span>
        <span className="font-bold text-lg tracking-tight text-white">Meteoracle</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {nav.map(({ href, icon: Icon, label }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-zinc-800 text-white font-medium'
                  : 'text-slate-400 hover:text-white hover:bg-zinc-800/60'
              }`}
            >
              <Icon size={16} />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="px-5 py-3 border-t border-surface-border">
        <span className="text-xs text-slate-600">v0.2.0</span>
      </div>
    </aside>
  )
}

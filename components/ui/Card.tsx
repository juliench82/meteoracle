import { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-surface-elevated border border-surface-border rounded-xl p-5 ${className}`}>
      {children}
    </div>
  )
}

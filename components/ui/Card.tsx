import { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`retro-card ${className}`}>
      {children}
    </div>
  )
}

import { ReactNode } from 'react'

type Variant = 'brand' | 'success' | 'danger' | 'warning' | 'neutral'

const styles: Record<Variant, string> = {
  brand: 'bg-brand/20 text-brand-light border-brand/30',
  success: 'bg-green-500/10 text-green-400 border-green-500/20',
  danger: 'bg-red-500/10 text-red-400 border-red-500/20',
  warning: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  neutral: 'bg-slate-800 text-slate-400 border-slate-700',
}

export function Badge({ children, variant = 'neutral' }: { children: ReactNode; variant?: Variant }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${styles[variant]}`}>
      {children}
    </span>
  )
}

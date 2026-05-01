import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Meteoracle',
  description: 'Solana trading bot dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-white antialiased">
        {children}
      </body>
    </html>
  )
}

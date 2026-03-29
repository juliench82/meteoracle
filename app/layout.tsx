import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Meteoracle',
  description: 'Multi-strategy Meteora DLMM LP automation bot',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-surface text-white antialiased min-h-screen">
        {children}
      </body>
    </html>
  )
}

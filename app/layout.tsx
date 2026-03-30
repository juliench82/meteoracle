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
  const botEnabled = process.env.BOT_ENABLED ?? 'false'
  const botDryRun = process.env.BOT_DRY_RUN ?? 'true'

  return (
    <html lang="en" className="dark">
      <head>
        <meta name="bot-enabled" content={botEnabled} />
        <meta name="bot-dry-run" content={botDryRun} />
      </head>
      <body className="bg-surface text-white antialiased min-h-screen">
        {children}
      </body>
    </html>
  )
}

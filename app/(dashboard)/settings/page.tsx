export default function SettingsPage() {
  const envVars = [
    { key: 'BOT_DRY_RUN',                   desc: 'Dry-run mode. Set to false for live trading.',    example: 'true' },
    { key: 'HELIUS_RPC_URL',                desc: 'Helius RPC endpoint with API key.',                example: 'https://mainnet.helius-rpc.com/?api-key=...' },
    { key: 'WALLET_PRIVATE_KEY',            desc: 'Base58 wallet private key. Keep secret.',         example: '(base58 string)' },
    { key: 'MIN_WALLET_BALANCE_SOL',        desc: 'Min SOL to keep in wallet as gas buffer.',         example: '0.05' },
    { key: 'SPOT_BUY_SLIPPAGE_BPS',         desc: 'Jupiter slippage tolerance in basis points.',     example: '300' },
    { key: 'SPOT_BUYER_POLL_SEC',           desc: 'Buyer poll interval in seconds.',                 example: '30' },
    { key: 'SPOT_MONITOR_POLL_SEC',         desc: 'Monitor poll interval in seconds.',               example: '30' },
    { key: 'TELEGRAM_BOT_TOKEN',            desc: 'Telegram bot token from @BotFather.',             example: '123456:ABC-...' },
    { key: 'TELEGRAM_CHAT_ID',              desc: 'Your Telegram chat or group ID.',                 example: '-100123456789' },
    { key: 'NEXT_PUBLIC_SUPABASE_URL',      desc: 'Supabase project URL.',                           example: 'https://xxx.supabase.co' },
    { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', desc: 'Supabase anon key (public).',                     example: 'eyJ...' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY',     desc: 'Supabase service role key (server only).',        example: 'eyJ...' },
  ]

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">
          All config is via environment variables in <code className="text-blue-400">.env.local</code>
        </p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Telegram Commands</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono">
          {[
            ['/status',     'Current state, open positions, last tick'],
            ['/start',      'Resume the bot'],
            ['/stop',       'Pause all scanning & monitoring'],
            ['/dry',        'Switch to dry-run (no real trades)'],
            ['/live',       'Switch to live trading ⚠️'],
            ['/scan',       'Run scanner manually'],
            ['/monitor',    'Run monitor manually'],
            ['/tick',       'Run scan + monitor together'],
            ['/close <id>', 'Force-close a position by ID'],
            ['/help',       'Show all commands'],
          ].map(([cmd, desc]) => (
            <div key={cmd} className="flex gap-3 bg-zinc-800 rounded px-3 py-2">
              <span className="text-blue-300 w-28 flex-shrink-0">{cmd}</span>
              <span className="text-zinc-400">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
        <div className="px-5 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-white">Environment Variables</h2>
          <p className="text-xs text-zinc-500">Set in <code>.env.local</code> (local) or Vercel dashboard (prod)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs uppercase border-b border-zinc-800">
                <th className="text-left px-5 py-3">Variable</th>
                <th className="text-left px-5 py-3">Description</th>
                <th className="text-left px-5 py-3">Example</th>
              </tr>
            </thead>
            <tbody>
              {envVars.map(v => (
                <tr key={v.key} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                  <td className="px-5 py-3"><code className="text-blue-300 text-xs">{v.key}</code></td>
                  <td className="px-5 py-3 text-zinc-400 text-xs">{v.desc}</td>
                  <td className="px-5 py-3"><code className="text-zinc-500 text-xs">{v.example}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

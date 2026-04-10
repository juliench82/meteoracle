export default function SettingsPage() {
  const envVars = [
    { key: 'BOT_DRY_RUN',                  desc: 'Dry-run mode. Set to false for live trading.',   example: 'true' },
    { key: 'HELIUS_RPC_URL',               desc: 'Helius RPC endpoint with API key.',               example: 'https://mainnet.helius-rpc.com/?api-key=...' },
    { key: 'WALLET_PRIVATE_KEY',           desc: 'Base58 wallet private key. Keep secret.',        example: '(base58 string)' },
    { key: 'SPOT_BUY_SOL',                 desc: 'SOL amount per buy.',                             example: '0.05' },
    { key: 'MAX_CONCURRENT_SPOTS',         desc: 'Max simultaneous open positions.',                example: '3' },
    { key: 'MAX_TOTAL_SPOT_SOL',           desc: 'Max total SOL deployed at once.',                 example: '0.15' },
    { key: 'MIN_WALLET_BALANCE_SOL',       desc: 'Min SOL to keep in wallet as gas buffer.',        example: '0.05' },
    { key: 'PRE_GRAD_MIN_VOL_5MIN_SOL',    desc: 'Min 5-min volume to qualify for a buy.',         example: '5' },
    { key: 'PRE_GRAD_TP_PCT',              desc: 'Take profit % target.',                           example: '200' },
    { key: 'PRE_GRAD_SL_PCT',              desc: 'Stop loss % (negative).',                        example: '-40' },
    { key: 'PRE_GRAD_MAX_HOLD_MIN',        desc: 'Max hold time before force-close.',              example: '240' },
    { key: 'PRE_GRAD_MIN_BONDING_PCT',     desc: 'Min bonding curve progress to consider.',        example: '80' },
    { key: 'PRE_GRAD_MAX_BONDING_PCT',     desc: 'Max bonding curve progress (avoid graduated).',  example: '99' },
    { key: 'SPOT_BUY_SLIPPAGE_BPS',        desc: 'Jupiter slippage tolerance in basis points.',    example: '300' },
    { key: 'SPOT_BUYER_POLL_SEC',          desc: 'Buyer poll interval in seconds.',                example: '30' },
    { key: 'SPOT_MONITOR_POLL_SEC',        desc: 'Monitor poll interval in seconds.',              example: '30' },
    { key: 'TELEGRAM_BOT_TOKEN',           desc: 'Telegram bot token from @BotFather.',            example: '123456:ABC-...' },
    { key: 'TELEGRAM_CHAT_ID',             desc: 'Your Telegram chat or group ID.',                example: '-100123456789' },
    { key: 'NEXT_PUBLIC_SUPABASE_URL',     desc: 'Supabase project URL.',                          example: 'https://xxx.supabase.co' },
    { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',desc: 'Supabase anon key (public).',                    example: 'eyJ...' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY',    desc: 'Supabase service role key (server only).',       example: 'eyJ...' },
  ]

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">All configuration is via environment variables in <code className="text-blue-400">.env.local</code></p>
      </div>

      {/* Go-live checklist */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Go-Live Checklist</h2>
        <ul className="space-y-2">
          {[
            { label: 'Run migration 002 in Supabase SQL editor',      code: 'ALTER TABLE spot_positions ADD COLUMN IF NOT EXISTS entry_price_usd NUMERIC DEFAULT 0;' },
            { label: 'Fund wallet with at least 0.5 SOL',             code: null },
            { label: 'Set BOT_DRY_RUN=false in .env.local',           code: 'BOT_DRY_RUN=false' },
            { label: 'Start all 3 bots via PM2',                      code: 'pm2 start ecosystem.config.cjs && pm2 save' },
            { label: 'Confirm Telegram alert fires on first buy',      code: null },
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 w-5 h-5 rounded-full border border-zinc-600 flex items-center justify-center text-xs text-zinc-500 flex-shrink-0">
                {i + 1}
              </span>
              <div>
                <p className="text-sm text-zinc-300">{item.label}</p>
                {item.code && (
                  <code className="text-xs text-blue-300 bg-zinc-800 px-2 py-0.5 rounded mt-1 block">
                    {item.code}
                  </code>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Env vars reference */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
        <div className="px-5 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-white">Environment Variables</h2>
          <p className="text-xs text-zinc-500">Set in <code>.env.local</code> (local) or Vercel dashboard (production)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs uppercase border-b border-zinc-800">
                <th className="text-left px-5 py-3">Variable</th>
                <th className="text-left px-5 py-3">Description</th>
                <th className="text-left px-5 py-3">Default / Example</th>
              </tr>
            </thead>
            <tbody>
              {envVars.map(v => (
                <tr key={v.key} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                  <td className="px-5 py-3">
                    <code className="text-blue-300 text-xs">{v.key}</code>
                  </td>
                  <td className="px-5 py-3 text-zinc-400 text-xs">{v.desc}</td>
                  <td className="px-5 py-3">
                    <code className="text-zinc-500 text-xs">{v.example}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

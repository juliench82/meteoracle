export default function StrategiesPage() {
  const strategies = [
    {
      id: 'evil-panda',
      name: 'Evil Panda',
      status: 'active',
      tag: 'DLMM LP',
      tagColor: 'bg-orange-900/60 text-orange-300',
      target: 'MEME_SHITCOIN',
      description:
        'Fee farming on early-stage, high-volatility memecoins using Meteora DLMM concentrated liquidity. ' +
        'Deploys single-sided SOL with an asymmetric range tuned to capture fees across typical memecoin price action. ' +
        'Exit logic is fee-yield-aware — positions close early when fees reach target yield, even under impermanent loss.',
      criteria: [
        { label: 'Type',          value: 'DLMM LP' },
        { label: 'Target',        value: 'Low-cap memes' },
        { label: 'Deposit',       value: 'Single-sided SOL' },
        { label: 'Distribution',  value: 'Bid-ask' },
        { label: 'Exit: OOR',     value: '45 min' },
        { label: 'Exit: Max Age', value: '72h' },
        { label: 'Fee exit',      value: 'Yes' },
      ],
    },
    {
      id: 'scalp-spike',
      name: 'Scalp Spike',
      status: 'active',
      tag: 'DLMM LP',
      tagColor: 'bg-yellow-900/60 text-yellow-300',
      target: 'SCALP_SPIKE',
      description:
        'Tight concentrated LP around current price on mid-cap tokens exhibiting sudden volume spikes. ' +
        'Designed to capture elevated fees during the spike window, with a short max duration and aggressive OOR exit.',
      criteria: [
        { label: 'Type',          value: 'DLMM LP' },
        { label: 'Target',        value: 'Mid-cap, vol spike' },
        { label: 'Deposit',       value: 'Dual-sided' },
        { label: 'Distribution',  value: 'Uniform' },
        { label: 'Exit: OOR',     value: '30 min' },
        { label: 'Exit: Max Age', value: '4h' },
        { label: 'Fee exit',      value: 'No' },
      ],
    },
    {
      id: 'stable-farm',
      name: 'Stable Farm',
      status: 'active',
      tag: 'DLMM LP',
      tagColor: 'bg-green-900/60 text-green-300',
      target: 'BLUECHIP / STABLE',
      description:
        'Conservative fee farming on established or stable pairs. Wide symmetric range, longer duration, lower maintenance. ' +
        'Targets pairs with deep liquidity, low volatility, and a consistent fee/TVL yield.',
      criteria: [
        { label: 'Type',          value: 'DLMM LP' },
        { label: 'Target',        value: 'Bluechip / Stable' },
        { label: 'Deposit',       value: 'Dual-sided' },
        { label: 'Distribution',  value: 'Uniform' },
        { label: 'Exit: OOR',     value: '60 min' },
        { label: 'Exit: Max Age', value: '7 days' },
        { label: 'Fee exit',      value: 'No' },
      ],
    },
  ]

  const statusDot = (s: string) =>
    s === 'active'
      ? 'inline-block w-2 h-2 rounded-full bg-green-400 mr-2'
      : 'inline-block w-2 h-2 rounded-full bg-zinc-600 mr-2'

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Strategies</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Active strategy profiles — each targets a distinct token risk class detected by the classifier.
        </p>
      </div>

      <div className="space-y-4">
        {strategies.map(s => (
          <div key={s.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={statusDot(s.status)} />
                  <h2 className="text-base font-semibold text-white">{s.name}</h2>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.tagColor}`}>
                    {s.tag}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400">
                    {s.target}
                  </span>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">{s.description}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-7 gap-2">
              {s.criteria.map(({ label, value }) => (
                <div key={label} className="bg-zinc-800 rounded-lg px-3 py-2">
                  <p className="text-xs text-zinc-500 mb-0.5">{label}</p>
                  <p className="text-sm font-semibold text-white">{value}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
        <h2 className="text-sm font-semibold text-white mb-3">Token Classifier</h2>
        <p className="text-xs text-zinc-500 mb-3">
          Every scanned token is assigned a risk class before strategy routing. Class and strategy ID are
          persisted on every candidate and position row, enabling per-class P&amp;L breakdown.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left text-xs font-medium text-zinc-500 pb-2 pr-4">Class</th>
                <th className="text-left text-xs font-medium text-zinc-500 pb-2 pr-4">Signal</th>
                <th className="text-left text-xs font-medium text-zinc-500 pb-2">Strategy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {[
                { cls: 'MEME_SHITCOIN', signal: 'Very new or very small — high fee potential, high risk', strat: 'Evil Panda' },
                { cls: 'SCALP_SPIKE',   signal: 'Mid-cap with abnormal volume velocity',                  strat: 'Scalp Spike' },
                { cls: 'BLUECHIP',      signal: 'Established, large, distributed holder base',            strat: 'Stable Farm' },
                { cls: 'STABLE',        signal: 'Known stablecoin or pegged asset',                       strat: 'Stable Farm' },
                { cls: 'UNKNOWN',       signal: 'No clean fit',                                           strat: '— skipped' },
              ].map(r => (
                <tr key={r.cls}>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-300">{r.cls}</td>
                  <td className="py-2 pr-4 text-xs text-zinc-400">{r.signal}</td>
                  <td className="py-2 text-xs text-zinc-300">{r.strat}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

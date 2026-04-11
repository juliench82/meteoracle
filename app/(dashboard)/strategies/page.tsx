export default function StrategiesPage() {
  const strategies = [
    {
      id: 'pre-grad',
      name: 'Pre-Grad Spot Buy',
      pipeline: 'Pipeline 2',
      tag: 'SPOT',
      tagColor: 'bg-blue-900 text-blue-300',
      description: 'Buys pump.fun tokens at 88–98% bonding curve. Rides the graduation pump, exits at TP or SL before or just after Meteora pool opens.',
      criteria: [
        { label: 'Curve Range',    value: '88 – 98%' },
        { label: 'Min Vol 5min',   value: '8 SOL' },
        { label: 'Min Holders',    value: '100' },
        { label: 'Max Top Holder', value: '12%' },
        { label: 'Max Dev Wallet', value: '3%' },
        { label: 'Buy Size',       value: '0.05 SOL' },
        { label: 'Max Positions',  value: '3' },
        { label: 'Take Profit',    value: '+150%' },
        { label: 'Stop Loss',      value: '−35%' },
        { label: 'Max Hold',       value: '90 min' },
      ],
    },
    {
      id: 'evil-panda',
      name: 'Evil Panda',
      pipeline: 'Pipeline 1',
      tag: 'DLMM LP',
      tagColor: 'bg-orange-900 text-orange-300',
      description: 'Wide-range memecoin fee farming on Meteora DLMM. Deploys single-sided SOL into −80% to +20% ranges on freshly graduated low-cap pairs. Earns fees as price falls through the range. Assumes the token WILL dump — that\'s the point.',
      criteria: [
        { label: 'MC Range',         value: '$50K – $5M' },
        { label: 'Min Vol 24h',      value: '$40K' },
        { label: 'Min Liquidity',    value: '$20K' },
        { label: 'Max Age',          value: '120h' },
        { label: 'Min Holders',      value: '200' },
        { label: 'Max Top Holder',   value: '25%' },
        { label: 'Min Rugcheck',     value: '40/100' },
        { label: 'Range',            value: '−80% / +20%' },
        { label: 'Bin Step',         value: '100' },
        { label: 'SOL Bias',         value: '80% SOL' },
        { label: 'Size',             value: '0.05 SOL' },
        { label: 'Stop Loss',        value: '−90%' },
        { label: 'Take Profit',      value: '+300%' },
        { label: 'OOR Exit',         value: '120 min' },
        { label: 'Max Duration',     value: '48h' },
      ],
    },
    {
      id: 'post-grad-lp',
      name: 'Post-Grad LP Migration',
      pipeline: 'Pipeline 3',
      tag: 'DLMM LP',
      tagColor: 'bg-purple-900 text-purple-300',
      description: 'Detects pre-grad spot positions that graduated successfully and migrates a portion of the bag into a Meteora DLMM LP to continue earning fees post-graduation.',
      criteria: [
        { label: 'Trigger',        value: 'Graduation detected' },
        { label: 'LP % of bag',    value: '50%' },
        { label: 'Range',          value: 'Evil Panda profile' },
        { label: 'Source',         value: 'pre-grad spot wins only' },
      ],
    },
    {
      id: 'scalp-spike',
      name: 'Scalp Spike',
      pipeline: 'Pipeline 1',
      tag: 'DLMM LP',
      tagColor: 'bg-yellow-900 text-yellow-300',
      description: 'Tight range LP around current price on tokens experiencing sudden volume spikes. Captures fees during the spike, exits quickly when volume normalises.',
      criteria: [
        { label: 'MC Range',       value: '$500K – $20M' },
        { label: 'Vol spike',      value: '3× 1h average' },
        { label: 'Range',          value: '±15%' },
        { label: 'Max Duration',   value: '4h' },
        { label: 'OOR Exit',       value: '30 min' },
      ],
    },
    {
      id: 'stable-farm',
      name: 'Stable Farm',
      pipeline: 'Pipeline 1',
      tag: 'DLMM LP',
      tagColor: 'bg-green-900 text-green-300',
      description: 'Conservative fee farming on stable or low-volatility pairs (SOL/USDC, SOL/mSOL). Wide symmetric range, long duration, low maintenance.',
      criteria: [
        { label: 'Pairs',          value: 'SOL/USDC, SOL/mSOL' },
        { label: 'Range',          value: '±10%' },
        { label: 'Bin Step',       value: '5–10' },
        { label: 'Max Duration',   value: '7 days' },
        { label: 'OOR Exit',       value: '60 min' },
      ],
    },
  ]

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Strategies</h1>
        <p className="text-sm text-zinc-500 mt-1">Reference for all active strategy configs and criteria</p>
      </div>

      <div className="space-y-4">
        {strategies.map(s => (
          <div key={s.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-base font-semibold text-white">{s.name}</h2>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.tagColor}`}>{s.tag}</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400">{s.pipeline}</span>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed">{s.description}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
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
    </div>
  )
}

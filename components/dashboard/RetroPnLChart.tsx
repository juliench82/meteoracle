'use client'

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

interface RetroPnLChartProps {
  data?: Array<{
    time: string
    pnl: number
    fees: number
  }>
}

// Sample retro-style data (in real usage this would come from the API)
const defaultData = [
  { time: '00:00', pnl: 0, fees: 12 },
  { time: '04:00', pnl: 48, fees: 19 },
  { time: '08:00', pnl: -21, fees: 31 },
  { time: '12:00', pnl: 87, fees: 44 },
  { time: '16:00', pnl: 134, fees: 52 },
  { time: '20:00', pnl: 92, fees: 67 },
  { time: '24:00', pnl: 176, fees: 81 },
]

export function RetroPnLChart({ data = defaultData }: RetroPnLChartProps) {
  return (
    <div className="retro-card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="label text-retro-pink">HISTORICAL PERFORMANCE</div>
          <div className="text-[10px] text-retro-cyan font-mono tracking-[1px] mt-0.5">
            LAST 24H • LIVE + FEES
          </div>
        </div>
        <a 
          href="https://app.meteora.ag/" 
          target="_blank" 
          rel="noreferrer"
          className="retro-btn text-[10px]"
        >
          FULL HISTORY ON METEORA →
        </a>
      </div>

      <div className="h-[240px] w-full -mx-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid 
              strokeDasharray="2 2" 
              stroke="#2a2a3d" 
              strokeOpacity={0.6}
            />
            <XAxis 
              dataKey="time" 
              stroke="#3a3a4d" 
              tick={{ fill: '#9ca3c9', fontSize: 10, fontFamily: 'monospace' }}
            />
            <YAxis 
              stroke="#3a3a4d" 
              tick={{ fill: '#9ca3c9', fontSize: 10, fontFamily: 'monospace' }}
            />
            <Tooltip 
              contentStyle={{
                backgroundColor: '#11111a',
                border: '2px solid #ff00aa',
                borderRadius: '2px',
                color: '#e0e0ff',
                fontFamily: 'monospace',
                fontSize: '12px'
              }}
            />
            {/* Neon Pink PnL Line */}
            <Line 
              type="monotone" 
              dataKey="pnl" 
              stroke="#ff00aa" 
              strokeWidth={3}
              dot={{ fill: '#ff00aa', stroke: '#0a0a12', strokeWidth: 2, r: 3 }}
              activeDot={{ r: 6, fill: '#ff00aa', stroke: '#fff' }}
            />
            {/* Neon Cyan Fees Line */}
            <Line 
              type="monotone" 
              dataKey="fees" 
              stroke="#00f9ff" 
              strokeWidth={2.5}
              strokeDasharray="3 2"
              dot={{ fill: '#00f9ff', stroke: '#0a0a12', strokeWidth: 2, r: 2.5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-6 mt-2 text-[10px] font-mono">
        <div className="flex items-center gap-2">
          <div className="w-3 h-0.5 bg-retro-pink" /> 
          <span className="text-retro-pink">REALIZED PnL</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-0.5 bg-retro-cyan border-t border-dashed border-retro-cyan" /> 
          <span className="text-retro-cyan">FEES EARNED</span>
        </div>
      </div>
    </div>
  )
}
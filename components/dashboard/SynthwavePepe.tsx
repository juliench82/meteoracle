'use client'

interface SynthwavePepeProps {
  laser?: 'green' | 'red' | 'neutral'
}

export function SynthwavePepe({ laser = 'neutral' }: SynthwavePepeProps) {
  const laserColor =
    laser === 'green'
      ? 'text-emerald-400'
      : laser === 'red'
      ? 'text-red-400'
      : 'text-retro-cyan'

  // Full Pepe with dynamic laser eyes
  const eyeLine = laser === 'green' || laser === 'red' ? '| >>   << |' : '|  o   o  |'

  const pepeArt = [
    '      .-.',
    '     /   \\',
    `    ${eyeLine}`,
    '     \\   /',
    '      | |',
    '     /   \\',
    '    | CLOAK |',
    '     \\_____/',
    '      PEPESYNTH',
  ].join('\n')

  return (
    <div className="flex flex-col items-center select-none">
      <pre className={`font-mono text-[8px] leading-[6.8px] ${laserColor}`}>
{pepeArt}
      </pre>

      <div className="font-mono text-[6px] text-retro-pink tracking-[1px] -mt-1 neon-pink">
        SYNTH PEPE
      </div>
      <div className="font-mono text-[5px] text-retro-purple -mt-0.5">IN THE CLOAK</div>
    </div>
  )
}

import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Retro 80s Synthwave / Outrun palette
        retro: {
          bg: '#0a0a12',
          surface: '#11111a',
          elevated: '#1a1a26',
          border: '#2a2a3d',
          pink: '#ff00aa',
          cyan: '#00f9ff',
          purple: '#bc13fe',
          lime: '#39ff14',
          orange: '#ff9500',
          yellow: '#ffeb3b',
        },
        brand: {
          DEFAULT: '#bc13fe',   // retro purple
          light: '#ff00aa',     // hot pink
          dark: '#6b0f9e',
        },
        surface: {
          DEFAULT: '#11111a',
          elevated: '#1a1a26',
          border: '#2a2a3d',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        retro: ['"Press Start 2P"', 'system-ui', 'monospace'], // optional fun font
      },
      boxShadow: {
        'neon-pink': '0 0 8px #ff00aa, 0 0 16px #ff00aa',
        'neon-cyan': '0 0 8px #00f9ff, 0 0 16px #00f9ff',
        'neon-purple': '0 0 8px #bc13fe, 0 0 16px #bc13fe',
      },
    },
  },
  plugins: [],
}

export default config

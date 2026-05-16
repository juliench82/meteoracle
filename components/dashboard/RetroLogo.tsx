'use client'

export function RetroLogo() {
  return (
    <div className="flex flex-col items-start">
      {/* Main Logo */}
      <div className="relative flex items-center gap-3">
        {/* SVG Retro Logo Mark */}
        <svg 
          width="52" 
          height="52" 
          viewBox="0 0 64 64" 
          fill="none" 
          xmlns="http://www.w3.org/2000/svg"
          className="drop-shadow-[0_0_12px_#ff00aa]"
        >
          {/* Grid background */}
          <rect width="64" height="64" fill="#0a0a12"/>
          <path d="M0 16H64M0 32H64M0 48H64M16 0V64M32 0V64M48 0V64" 
                stroke="#2a2a3d" strokeWidth="0.75" opacity="0.6"/>
          
          {/* Sunset gradient horizon */}
          <defs>
            <linearGradient id="sunset" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#bc13fe" stopOpacity="0.9"/>
              <stop offset="50%" stopColor="#ff00aa" stopOpacity="0.8"/>
              <stop offset="100%" stopColor="#ff9500" stopOpacity="0.6"/>
            </linearGradient>
          </defs>
          
          {/* Horizon line */}
          <rect x="4" y="38" width="56" height="22" fill="url(#sunset)" opacity="0.85"/>
          
          {/* Palm tree silhouette (classic 80s) */}
          <path d="M32 52 Q28 42 24 38 Q26 36 30 40 Q32 34 34 40 Q38 36 40 38 Q36 42 32 52" 
                fill="#0a0a12"/>
          <path d="M32 52 Q30 46 27 44" stroke="#0a0a12" strokeWidth="2"/>
          
          {/* Neon Meteor / Orb */}
          <circle cx="32" cy="28" r="9" fill="#0a0a12" stroke="#00f9ff" strokeWidth="2.5"/>
          <circle cx="32" cy="28" r="5" fill="#ff00aa"/>
          <circle cx="34" cy="26" r="2" fill="#fff" opacity="0.9"/>
        </svg>

        {/* Text Logo */}
        <div className="flex flex-col -space-y-1">
          <div 
            className="font-mono text-[42px] font-black tracking-[6px] leading-none neon-pink select-none"
            style={{ 
              textShadow: '0 0 10px #ff00aa, 0 0 20px #ff00aa, 0 0 40px #bc13fe',
              fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
            }}
          >
            METEORACLE
          </div>
          <div className="font-mono text-[10px] text-retro-cyan tracking-[4px] pl-1 -mt-1">
            1986 • OUTRUN EDITION
          </div>
        </div>
      </div>

      {/* Tagline */}
      <div className="ml-[60px] mt-1 text-[9px] font-mono tracking-[3px] text-retro-lime">
        SOLANA LIQUIDITY • SYNTHWAVE MODE
      </div>
    </div>
  )
}
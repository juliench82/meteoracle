# Meteoracle

**Minimal, focused Solana Meteora DLMM LP bot.**

Meteoracle provides automated one-sided SOL liquidity provision on Meteora DLMM pools using the Evil Panda **top-performer activity strategy**, paired with a robust 4-rule exit monitor, fully local state management, and rich Telegram-based control and observability.

It is deliberately scoped to **pure DLMM LP operations** on Meteora — no companion strategies, no legacy code, no external database dependencies in the hot path.

## Key Features

- **Evil Panda Top-Performer Strategy** (fully aligned to latest Claude recommendations — ONLY real fields from dlmm.datapi.meteora.ag/pools):
  Server-side: tvl >= 500 && fee_24h >= 5 , sort_by=fee_tvl_ratio_1h:desc
  Derived: volume_1h / fee_pct (implied active), fee_1h > fee_2h/2 (accel), age > 2h, fee_tvl_24h >= 0.5%
  lp_count only on final survivors (positions query)
  Take top 5, deep-check, open #1.
  All previous "very fresh 15m", non-existent active_tvl, and old hard-filter logic completely removed.
- **4-Rule Exit Engine** (monitor every ~60s):
  1. Fee/TVL yield collapse (4h rolling avg of 24h Fee/TVL < threshold)
  2. Prolonged out-of-range (OOR)
  3. Net PnL stop-loss (price move + fees, after grace period)
  4. Hard max duration safety cap (1h)
- **Local State Only**: All positions and state live in `state/` JSON files. No Supabase required for runtime.
- **Full Telegram Control**: Start/stop, dry/live mode, force tick, view positions with live metrics, manual close, etc.
- **Rich Alerts**: Detailed open/close notifications including rugcheck, holders, net PnL, Fee/TVL, OOR time, and more.
- **Dry-Run Support**: Safe simulation mode that still exercises the full decision + monitoring logic.
- **Optional Helius Integration**: For holder counts, rugcheck, and Pump.fun bonding curve progress on graduated tokens.
- **Clean & Maintainable**: Ultra-minimal architecture after complete redesign. Previous "very fresh 15m" and non-real active_tvl models have been fully removed. Only the Evil Panda top-performer path remains.

No dashboard. No multi-strategy system. No on-chain position syncing or rebalancing.

## Quick Start

```bash
cd meteoracle
npm install
npm run build
```

Create or edit `.env.local` (see `.env.local.example`):

```env
BOT_ENABLED=true
BOT_DRY_RUN=true          # Keep true until confident
LP_SCANNER_ENABLED=true
LP_MONITOR_ENABLED=true
EVIL_PANDA_ENABLED=true

# Optional but recommended
HELIUS_ENABLED=false      # Enable for better holder/rugcheck data
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Run:

```bash
npm run worker
```

Use the Telegram bot to interact (`/help` for commands). Start with dry-run, observe a few cycles with `/tick`, then switch to live when ready.

## Telegram Commands

- `/help` — List available commands
- `/status` — Bot state + open position counts
- `/positions` — Detailed open LP positions with live exit signals (Net PnL, 4h Fee/TVL, OOR, age)
- `/tick` — Force one full scanner + monitor cycle
- `/start` — Enable the bot (soft)
- `/stop` — Disable the bot
- `/dry` — Enable dry-run mode
- `/live` — Enable live trading (real money)
- `/reload` — Restart processes (use after code changes)
- `/close <id>` — Force close a specific position

All control and observability happens through Telegram. State is always in `state/`.

## Configuration

Key environment variables (see `.env.local.example` for full list and comments):

| Variable                        | Default | Description |
|--------------------------------|---------|-------------|
| `BOT_ENABLED`                  | false   | Master enable for the worker |
| `BOT_DRY_RUN`                  | true    | Simulation mode (no on-chain tx) |
| `LP_SCANNER_ENABLED`           | true    | Enable fresh pool scanning |
| `LP_MONITOR_ENABLED`           | true    | Enable position monitoring & exits |
| `EVIL_PANDA_ENABLED`           | true    | Enable the core LP strategy |
| `MIN_TVL_USD`                  | 500     | Server-side tvl >= filter |
| `MIN_FEE_24H`                  | 5       | Server-side fee_24h >= filter |
| `MIN_FEE_TVL_RATIO_24H`        | 0.005   | fee_tvl_ratio_24h >= 0.5% |
| `MIN_IMPLIED_ACTIVE_TVL`       | 330     | volume_1h / fee_pct >= |
| `MAX_IMPLIED_ACTIVE_TVL`       | 750000  | volume_1h / fee_pct <= |
| `MIN_LP_COUNT`                 | 3       | lp count on survivors only |
| `MIN_POOL_AGE_HOURS`           | 2       | age > 2h (from pool_created_at) |
| `ACTIVITY_MAX_POOL_AGE_MINUTES`| 4320    | broad fetch window |

| `MAX_CONCURRENT_MARKET_LP_POSITIONS` | 5 | Max concurrent LP positions |
| `LP_FEE_TVL_EXIT_THRESHOLD`    | 0.75    | 4h avg Fee/TVL % below this → exit |
| `LP_NET_LOSS_SL_PCT`           | -30     | Net PnL stop-loss threshold |
| `HELIUS_ENABLED`               | false   | Use Helius for holders/rugcheck/bonding curves |

Runtime state and logs live under `state/`.

## Architecture Overview

```
worker.ts
├── tickScanner()   → runScanner() (deep-checker.ts)
│                     └── fetchMeteoraPools → fresh filter → evil-panda evaluation → open
└── tickMonitor()   → monitorPositions() (monitor.ts)
                      └── 4-rule LP exits + stranded sell recovery + rich alerts
```

- **Scanner**: Uses targeted list from datapi with server-side real-field filters + sort_by fee_tvl_ratio_1h, applies derived proxies (implied active, accel, age>2h), enriches lp_count on survivors only, then deep checks and opens the top one. Completely redesigned from previous fresh/active_tvl models.
- **Monitor**: On-chain DLMM queries + persisted samples for Fee/TVL and net PnL. Triggers exits with detailed Telegram close alerts. Enriched with the same activity signals when available.
- **State**: `state/open-lp-positions.json` is the source of truth.
- **Control**: `bot/telegram-bot.ts` (long-polling) provides the full operator interface.
- **Alerts**: `bot/alerter.ts` produces rich Markdown notifications for all key events.

Everything is designed for low operational overhead and easy observability via Telegram + local logs.

## Development

```bash
npm run build          # Compile to dist/
npm run type-check     # TypeScript check
npm run worker         # Run with tsx (dev)
```

The production entrypoint is `dist/worker.js` (see `ecosystem.config.cjs` for PM2).

### Project Structure (key paths)

- `worker.ts` — Main entry (scanner + monitor loops)
- `bot/scanner/` — Pool fetching, fresh filtering, decision logic
- `bot/executor/` — Position open/close/add-liquidity (DLMM SDK + Jupiter fallbacks)
- `bot/monitor.ts` — 4-rule exit engine
- `bot/telegram-bot.ts` — Operator interface
- `lib/local-state.ts` — JSON persistence for LP positions
- `lib/strategy-config.ts` — All tunable parameters
- `strategies/evil-panda.ts` — The active LP strategy definition

## Important Notes

- Always start with `BOT_DRY_RUN=true`.
- The bot is intentionally minimal. It does one thing well: find currently strong 24h fee-yielding DLMM pools using the live-data activity criteria, provide one-sided SOL liquidity, and exit according to clear, observable rules.
- All hot paths use local state + targeted on-chain reads. Supabase is legacy-only.
- The scanner uses only fields that actually exist in the /pools list API (plus cheap derivations from volume/fee windows). lp_count is the only expensive step and is done only on final candidates. Rich logs show exactly which real filter or derivation rejected a pool.

For questions or issues, use the Telegram interface or inspect `state/` + logs.

---

Meteoracle — clean, observable, focused DLMM LP automation.

# Meteoracle

Minimal Solana DLMM liquidity bot.

**Current scope:**
- Opens positions only with the `evil-panda` strategy on very fresh tokens.
- Triggers companion `moonboy` spot buys ($10) on qualifying fresh tokens.
- Maximum 3 concurrent Moonboy positions.
- Moonboy exits at +100% (2x), with basic risk controls.
- Runtime state lives in local JSON files (`state/`), not in the database.
- Supabase usage is minimal / legacy-only (hot paths use local state + on-chain only).

No dashboard. No multi-strategy system. No hybrid DB + on-chain position syncing.

Run with:
```bash
npm run worker
```

Keep `BOT_DRY_RUN=true` until you are confident with the setup.

# Trade log (published)

This directory holds the **safe, publishable** trade-log artifacts. Real values
never leave the founder's machine — they live only in `state/trade-log.json`
(which is gitignored).

## Files

| File | What it is |
|---|---|
| `trade-log.json` | Redacted real log: structural fields kept (`id`, `symbol`, `opened_at`, `closed_at`, `mode`, `close_reason`); every monetary field emitted as `null` with a per-row `redacted: true` flag. Empty (with a notice) until the first position closes. |
| `trade-log.synthetic.json` | Deterministic built-in demo fixture (≥30 closed rows) covering all four exit rules (`fee_tvl_yield_low`, `oor`, `net_pnl_sl`, `max_duration`) plus `manual_close` and `sell_failed`, in both `dry_run` and `live` modes. Header marks it `"synthetic": true`. |

## Row schema

Every row carries every field:

```
id               string   position id
symbol           string   token symbol
mode             "dry_run" | "live"
opened_at        string   ISO timestamp
closed_at        string   ISO timestamp
close_reason     string   exit rule that closed the position
sol_deposited    null     redacted (monetary)
net_pnl_pct      null     redacted (monetary)
last_fee_tvl_4h_avg  null redacted (monetary)
fees_sol         null     redacted (monetary)
il_sol           null     redacted (monetary)
gas_sol          null     redacted (monetary)
rent_sol         null     redacted (monetary)
redacted         true
```

## Redaction policy

- STRUCTURAL fields are real and safe: position id, symbol, open/close
  timestamps, mode, close reason.
- MONETARY fields (`sol_deposited`, `net_pnl_pct`, `last_fee_tvl_4h_avg`,
  `fees_sol`, `il_sol`, `gas_sol`, `rent_sol`) are always `null` + `redacted: true`.
- The generator runs a **fail-closed self-check** before writing: it scans its
  own output for any 32–44 char base58 token (wallet/pubkey/mint/pool address)
  and for any non-null monetary value. Any hit → exit non-zero, nothing written.

## NEVER published

Wallet private keys or public keys, position pubkeys, pool addresses, token
mints (base58 addresses), real SOL amounts, real fees / IL / gas / rent, real
net PnL, real names, contact info, Telegram IDs, chat IDs.

## Regenerate

```bash
npm run trade-log:publish
```

Reads `state/trade-log.json` (missing/empty is fine — emits an empty redacted
log with a notice) and rewrites both artifacts deterministically (same input →
byte-identical output, sorted by `closed_at` then `id`).

## Real-value publication requires founder approval

Publishing the real (non-redacted) trade log is a separate, approval-gated
founder action. This pipeline NEVER emits real monetary values by construction.

## Notes

- The ledger starts accruing on the next closed position; the synthetic fixture
  demonstrates the target shape (≥30 closed rows) today.
- Historical rows can be backfilled by hand into `state/trade-log.json` later
  (same schema) and re-published.
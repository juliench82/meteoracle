-- Add entry_usd_value to lp_positions
-- Stores the USD value of SOL deposited at position open time.
-- Formula: sol_deposited * (entry_price_usd / entry_price_sol)
-- Null for rows opened before this migration (no backfill — entry_price_sol may be 0).

ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS entry_usd_value numeric;

-- Backfill rows where both price columns are non-zero and > 0
UPDATE lp_positions
SET entry_usd_value = ROUND(
  (sol_deposited * (entry_price_usd / entry_price_sol))::numeric,
  2
)
WHERE entry_usd_value IS NULL
  AND entry_price_sol IS NOT NULL
  AND entry_price_sol > 0
  AND entry_price_usd IS NOT NULL
  AND entry_price_usd > 0
  AND sol_deposited   IS NOT NULL
  AND sol_deposited   > 0;

COMMENT ON COLUMN lp_positions.entry_usd_value IS
  'USD value of SOL deposited at open: sol_deposited * sol_price_usd_at_open. Used as PnL cost basis.';

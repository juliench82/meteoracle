-- Removes the legacy SOL-denominated LP fee column.
-- Claimable fees are tracked in claimable_fees_usd from Meteora snapshots.

ALTER TABLE lp_positions
  DROP COLUMN IF EXISTS fees_earned_sol;

NOTIFY pgrst, 'reload schema';

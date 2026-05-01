-- Adds the DLMM fee accumulator column for existing lp_positions tables.
-- Some production databases predate 003_lp_positions.sql, so CREATE TABLE IF
-- NOT EXISTS did not backfill this column.

ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS fees_earned_sol NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN lp_positions.fees_earned_sol IS
  'Accumulated LP fees in SOL-equivalent units, written by executor and monitor.';

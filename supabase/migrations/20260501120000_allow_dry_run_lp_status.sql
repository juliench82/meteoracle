-- Allows dry-run DAMM/DLMM rows to be represented explicitly in lp_positions.status.

ALTER TABLE lp_positions
  DROP CONSTRAINT IF EXISTS lp_positions_status_check;

ALTER TABLE lp_positions
  ADD CONSTRAINT lp_positions_status_check
  CHECK (status IN (
    'active',
    'open',
    'dry_run',
    'out_of_range',
    'closed',
    'pending_retry',
    'pending_close',
    'error',
    'orphaned'
  ));

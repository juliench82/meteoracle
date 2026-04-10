-- Pre-graduation watchlist: tokens detected on pump.fun before they migrate to Meteora
CREATE TABLE IF NOT EXISTS pre_grad_watchlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint            text NOT NULL UNIQUE,
  symbol          text,
  name            text,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  bonding_progress numeric(5,2),      -- 0–100 % of bonding curve filled
  market_cap_usd  numeric,
  volume_1h_usd   numeric,
  holder_count    int,
  graduated_at    timestamptz,        -- set when we see a Meteora pool appear
  status          text NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','graduated','expired','opened','rejected')),
  reject_reason   text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pre_grad_status   ON pre_grad_watchlist(status);
CREATE INDEX IF NOT EXISTS idx_pre_grad_mint     ON pre_grad_watchlist(mint);
CREATE INDEX IF NOT EXISTS idx_pre_grad_detected ON pre_grad_watchlist(detected_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_pre_grad_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_pre_grad_updated_at ON pre_grad_watchlist;
CREATE TRIGGER trg_pre_grad_updated_at
  BEFORE UPDATE ON pre_grad_watchlist
  FOR EACH ROW EXECUTE FUNCTION update_pre_grad_updated_at();

-- Also add oor_since_at to positions if it doesn't exist yet
ALTER TABLE positions ADD COLUMN IF NOT EXISTS oor_since_at timestamptz;

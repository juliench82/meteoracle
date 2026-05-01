-- 003_lp_positions.sql
-- Tracks Meteora DLMM LP positions opened after token graduation.

create table if not exists lp_positions (
  id                  uuid primary key default uuid_generate_v4(),

  -- Link back to the spot position that triggered this LP
  spot_position_id    uuid references spot_positions(id) on delete set null,

  mint                text not null,
  symbol              text not null,
  pool_address        text not null,

  -- DLMM on-chain position pubkey (for removeLiquidity calls)
  position_pubkey     text,

  -- Capital
  token_amount        numeric not null default 0,   -- tokens deposited into LP
  sol_deposited       numeric not null default 0,   -- SOL-equivalent value at entry

  -- Bin range
  bin_lower           integer,
  bin_upper           integer,
  entry_bin           integer,

  -- Pricing
  entry_price_usd     numeric not null default 0,

  -- Status
  status              text not null default 'active'
                        check (status in ('active', 'out_of_range', 'closed', 'pending_retry', 'error')),
  in_range            boolean not null default true,
  oor_since_at        timestamptz,

  -- Dry-run flag mirrors parent spot position
  dry_run             boolean not null default true,

  -- Lifecycle
  opened_at           timestamptz not null default now(),
  closed_at           timestamptz,
  close_reason        text,
  pnl_sol             numeric,

  -- Raw tx hashes
  tx_open             text,
  tx_close            text,

  metadata            jsonb
);

create index on lp_positions (status);
create index on lp_positions (mint);
create index on lp_positions (opened_at desc);
create index on lp_positions (spot_position_id);

-- Add graduated flag to spot_positions so migrator knows what to pick up
alter table spot_positions add column if not exists graduated     boolean not null default false;
alter table spot_positions add column if not exists lp_migrated   boolean not null default false;
alter table spot_positions add column if not exists graduated_at  timestamptz;

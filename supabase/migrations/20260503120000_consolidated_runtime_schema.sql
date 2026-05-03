-- Meteoracle consolidated runtime schema.
-- Replaces the older fragmented migrations with the tables and indexes the
-- current scanner, executors, monitor, dashboard, and Telegram bot use.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Runtime kill switch and dry-run control.
create table if not exists public.bot_state (
  id integer primary key default 1,
  enabled boolean not null default false,
  dry_run boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_state_singleton check (id = 1)
);

alter table public.bot_state add column if not exists enabled boolean not null default false;
alter table public.bot_state add column if not exists dry_run boolean not null default true;
alter table public.bot_state add column if not exists created_at timestamptz not null default now();
alter table public.bot_state add column if not exists updated_at timestamptz not null default now();

insert into public.bot_state (id, enabled, dry_run)
values (1, false, true)
on conflict (id) do nothing;

drop trigger if exists set_bot_state_updated_at on public.bot_state;
create trigger set_bot_state_updated_at
before update on public.bot_state
for each row execute function public.set_updated_at();

-- Structured operational logs used by API status, scanner, executor, and monitor.
create table if not exists public.bot_logs (
  id uuid primary key default gen_random_uuid(),
  level text not null default 'info',
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.bot_logs add column if not exists level text not null default 'info';
alter table public.bot_logs add column if not exists event text not null default 'unknown';
alter table public.bot_logs add column if not exists payload jsonb not null default '{}'::jsonb;
alter table public.bot_logs add column if not exists created_at timestamptz not null default now();

create index if not exists idx_bot_logs_created_at on public.bot_logs (created_at desc);
create index if not exists idx_bot_logs_event_created_at on public.bot_logs (event, created_at desc);
create index if not exists idx_bot_logs_level_created_at on public.bot_logs (level, created_at desc);
create index if not exists idx_bot_logs_payload_gin on public.bot_logs using gin (payload);

-- Scanner candidates. Both lanes write here:
-- fresh => Evil Panda/DAMM launch, momentum => all-age Scalp Spike.
create table if not exists public.candidates (
  id uuid primary key default gen_random_uuid(),
  token_address text not null,
  symbol text not null,
  pool_address text,
  scanner_lane text,
  score integer not null default 0,
  strategy_matched text,
  strategy_id text,
  token_class text,
  launchpad_source text,
  mc_at_scan numeric,
  volume_24h numeric,
  volume_1h numeric,
  volume_5m numeric,
  liquidity_usd numeric,
  fee_tvl_24h_pct numeric,
  fee_tvl_1h_pct numeric,
  fee_tvl_5m_pct numeric,
  holder_count integer,
  rugcheck_score integer,
  top_holder_pct numeric,
  bin_step integer,
  score_volmc numeric,
  score_holders numeric,
  score_freshness numeric,
  score_fee_efficiency numeric,
  score_volume_tvl numeric,
  score_curve_bonus numeric,
  metadata jsonb not null default '{}'::jsonb,
  scanned_at timestamptz not null default now()
);

alter table public.candidates add column if not exists token_address text;
alter table public.candidates add column if not exists symbol text;
alter table public.candidates add column if not exists pool_address text;
alter table public.candidates add column if not exists scanner_lane text;
alter table public.candidates add column if not exists score integer not null default 0;
alter table public.candidates add column if not exists strategy_matched text;
alter table public.candidates add column if not exists strategy_id text;
alter table public.candidates add column if not exists token_class text;
alter table public.candidates add column if not exists launchpad_source text;
alter table public.candidates add column if not exists mc_at_scan numeric;
alter table public.candidates add column if not exists volume_24h numeric;
alter table public.candidates add column if not exists volume_1h numeric;
alter table public.candidates add column if not exists volume_5m numeric;
alter table public.candidates add column if not exists liquidity_usd numeric;
alter table public.candidates add column if not exists fee_tvl_24h_pct numeric;
alter table public.candidates add column if not exists fee_tvl_1h_pct numeric;
alter table public.candidates add column if not exists fee_tvl_5m_pct numeric;
alter table public.candidates add column if not exists holder_count integer;
alter table public.candidates add column if not exists rugcheck_score integer;
alter table public.candidates add column if not exists top_holder_pct numeric;
alter table public.candidates add column if not exists bin_step integer;
alter table public.candidates add column if not exists score_volmc numeric;
alter table public.candidates add column if not exists score_holders numeric;
alter table public.candidates add column if not exists score_freshness numeric;
alter table public.candidates add column if not exists score_fee_efficiency numeric;
alter table public.candidates add column if not exists score_volume_tvl numeric;
alter table public.candidates add column if not exists score_curve_bonus numeric;
alter table public.candidates add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.candidates add column if not exists scanned_at timestamptz not null default now();

create index if not exists idx_candidates_scanned_at on public.candidates (scanned_at desc);
create index if not exists idx_candidates_token_scanned_at on public.candidates (token_address, scanned_at desc);
create index if not exists idx_candidates_strategy_scanned_at on public.candidates (strategy_id, scanned_at desc);
create index if not exists idx_candidates_lane_scanned_at on public.candidates (scanner_lane, scanned_at desc);
create index if not exists idx_candidates_score_scanned_at on public.candidates (score desc, scanned_at desc);
create index if not exists idx_candidates_launchpad_scanned_at on public.candidates (launchpad_source, scanned_at desc);
create index if not exists idx_candidates_metadata_gin on public.candidates using gin (metadata);

-- Canonical LP position cache. Meteora live state remains source of truth, but
-- this table stores bot ownership, strategy metadata, open/close txs, and UI cache.
create table if not exists public.lp_positions (
  id uuid primary key default gen_random_uuid(),
  mint text not null,
  token_address text,
  symbol text,
  pool_address text,
  position_pubkey text,
  strategy_id text,
  position_type text not null default 'dlmm',
  token_amount numeric not null default 0,
  sol_deposited numeric not null default 0,
  entry_price numeric,
  entry_price_sol numeric,
  entry_price_usd numeric,
  current_price numeric,
  claimable_fees_usd numeric,
  position_value_usd numeric,
  pnl_sol numeric,
  pnl_usd numeric,
  realized_pnl_usd numeric,
  il_pct numeric,
  status text not null default 'active',
  in_range boolean not null default true,
  dry_run boolean not null default false,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  oor_since_at timestamptz,
  close_reason text,
  tx_open text,
  tx_close text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lp_positions add column if not exists mint text;
alter table public.lp_positions add column if not exists token_address text;
alter table public.lp_positions add column if not exists symbol text;
alter table public.lp_positions add column if not exists pool_address text;
alter table public.lp_positions add column if not exists position_pubkey text;
alter table public.lp_positions add column if not exists strategy_id text;
alter table public.lp_positions add column if not exists position_type text not null default 'dlmm';
alter table public.lp_positions add column if not exists token_amount numeric not null default 0;
alter table public.lp_positions add column if not exists sol_deposited numeric not null default 0;
alter table public.lp_positions add column if not exists entry_price numeric;
alter table public.lp_positions add column if not exists entry_price_sol numeric;
alter table public.lp_positions add column if not exists entry_price_usd numeric;
alter table public.lp_positions add column if not exists current_price numeric;
alter table public.lp_positions add column if not exists claimable_fees_usd numeric;
alter table public.lp_positions add column if not exists position_value_usd numeric;
alter table public.lp_positions add column if not exists pnl_sol numeric;
alter table public.lp_positions add column if not exists pnl_usd numeric;
alter table public.lp_positions add column if not exists realized_pnl_usd numeric;
alter table public.lp_positions add column if not exists il_pct numeric;
alter table public.lp_positions add column if not exists status text not null default 'active';
alter table public.lp_positions add column if not exists in_range boolean not null default true;
alter table public.lp_positions add column if not exists dry_run boolean not null default false;
alter table public.lp_positions add column if not exists opened_at timestamptz not null default now();
alter table public.lp_positions add column if not exists closed_at timestamptz;
alter table public.lp_positions add column if not exists oor_since_at timestamptz;
alter table public.lp_positions add column if not exists close_reason text;
alter table public.lp_positions add column if not exists tx_open text;
alter table public.lp_positions add column if not exists tx_close text;
alter table public.lp_positions add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.lp_positions add column if not exists created_at timestamptz not null default now();
alter table public.lp_positions add column if not exists updated_at timestamptz not null default now();

update public.lp_positions
set token_address = coalesce(token_address, mint)
where token_address is null and mint is not null;

drop trigger if exists set_lp_positions_updated_at on public.lp_positions;
create trigger set_lp_positions_updated_at
before update on public.lp_positions
for each row execute function public.set_updated_at();

create unique index if not exists idx_lp_positions_position_pubkey_unique
  on public.lp_positions (position_pubkey)
  where position_pubkey is not null and position_pubkey not like 'DRY_RUN%';
create index if not exists idx_lp_positions_open_status
  on public.lp_positions (status, opened_at desc)
  where status in ('active', 'open', 'out_of_range', 'pending_retry', 'orphaned', 'dry_run');
create index if not exists idx_lp_positions_mint_status on public.lp_positions (mint, status);
create index if not exists idx_lp_positions_token_address_status on public.lp_positions (token_address, status);
create index if not exists idx_lp_positions_pool_address on public.lp_positions (pool_address);
create index if not exists idx_lp_positions_strategy_status on public.lp_positions (strategy_id, status);
create index if not exists idx_lp_positions_position_type_status on public.lp_positions (position_type, status);
create index if not exists idx_lp_positions_closed_at on public.lp_positions (closed_at desc);
create index if not exists idx_lp_positions_metadata_gin on public.lp_positions using gin (metadata);

-- Legacy spot table is still read by dashboard/status routes.
create table if not exists public.spot_positions (
  id uuid primary key default gen_random_uuid(),
  token_address text,
  mint text,
  symbol text,
  token_amount numeric not null default 0,
  sol_spent numeric not null default 0,
  entry_price numeric,
  current_price numeric,
  pnl_sol numeric,
  pnl_usd numeric,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text,
  tx_open text,
  tx_close text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.spot_positions add column if not exists token_address text;
alter table public.spot_positions add column if not exists mint text;
alter table public.spot_positions add column if not exists symbol text;
alter table public.spot_positions add column if not exists token_amount numeric not null default 0;
alter table public.spot_positions add column if not exists sol_spent numeric not null default 0;
alter table public.spot_positions add column if not exists entry_price numeric;
alter table public.spot_positions add column if not exists current_price numeric;
alter table public.spot_positions add column if not exists pnl_sol numeric;
alter table public.spot_positions add column if not exists pnl_usd numeric;
alter table public.spot_positions add column if not exists status text not null default 'open';
alter table public.spot_positions add column if not exists opened_at timestamptz not null default now();
alter table public.spot_positions add column if not exists closed_at timestamptz;
alter table public.spot_positions add column if not exists close_reason text;
alter table public.spot_positions add column if not exists tx_open text;
alter table public.spot_positions add column if not exists tx_close text;
alter table public.spot_positions add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.spot_positions add column if not exists created_at timestamptz not null default now();
alter table public.spot_positions add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_spot_positions_updated_at on public.spot_positions;
create trigger set_spot_positions_updated_at
before update on public.spot_positions
for each row execute function public.set_updated_at();

create index if not exists idx_spot_positions_status_opened_at on public.spot_positions (status, opened_at desc);
create index if not exists idx_spot_positions_closed_at on public.spot_positions (closed_at desc);
create index if not exists idx_spot_positions_token_address on public.spot_positions (token_address);

-- Dashboard watchlist for launchpad tokens before graduation.
create table if not exists public.pre_grad_watchlist (
  id uuid primary key default gen_random_uuid(),
  mint text not null,
  symbol text,
  launchpad_source text,
  bonding_curve_pct numeric,
  holder_count integer,
  top_holder_pct numeric,
  rugcheck_score integer,
  market_cap_usd numeric,
  liquidity_usd numeric,
  volume_5m numeric,
  volume_1h numeric,
  velocity_5m numeric,
  velocity_1h numeric,
  status text not null default 'watching',
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz,
  graduated_at timestamptz,
  opened_position_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pre_grad_watchlist add column if not exists mint text;
alter table public.pre_grad_watchlist add column if not exists symbol text;
alter table public.pre_grad_watchlist add column if not exists launchpad_source text;
alter table public.pre_grad_watchlist add column if not exists bonding_curve_pct numeric;
alter table public.pre_grad_watchlist add column if not exists holder_count integer;
alter table public.pre_grad_watchlist add column if not exists top_holder_pct numeric;
alter table public.pre_grad_watchlist add column if not exists rugcheck_score integer;
alter table public.pre_grad_watchlist add column if not exists market_cap_usd numeric;
alter table public.pre_grad_watchlist add column if not exists liquidity_usd numeric;
alter table public.pre_grad_watchlist add column if not exists volume_5m numeric;
alter table public.pre_grad_watchlist add column if not exists volume_1h numeric;
alter table public.pre_grad_watchlist add column if not exists velocity_5m numeric;
alter table public.pre_grad_watchlist add column if not exists velocity_1h numeric;
alter table public.pre_grad_watchlist add column if not exists status text not null default 'watching';
alter table public.pre_grad_watchlist add column if not exists detected_at timestamptz not null default now();
alter table public.pre_grad_watchlist add column if not exists last_seen_at timestamptz;
alter table public.pre_grad_watchlist add column if not exists graduated_at timestamptz;
alter table public.pre_grad_watchlist add column if not exists opened_position_id uuid;
alter table public.pre_grad_watchlist add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.pre_grad_watchlist add column if not exists created_at timestamptz not null default now();
alter table public.pre_grad_watchlist add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_pre_grad_watchlist_updated_at on public.pre_grad_watchlist;
create trigger set_pre_grad_watchlist_updated_at
before update on public.pre_grad_watchlist
for each row execute function public.set_updated_at();

create unique index if not exists idx_pre_grad_watchlist_mint_unique on public.pre_grad_watchlist (mint);
create index if not exists idx_pre_grad_watchlist_status_detected_at on public.pre_grad_watchlist (status, detected_at desc);
create index if not exists idx_pre_grad_watchlist_bonding_curve on public.pre_grad_watchlist (bonding_curve_pct desc);

-- Pool-level scan cache for slower momentum lanes and dedupe. The current bot can
-- run both lanes in one process; this table lets us split schedules later without
-- re-checking the same all-age pools every fast tick.
create table if not exists public.scanner_pool_cache (
  id uuid primary key default gen_random_uuid(),
  pool_address text not null,
  token_address text not null,
  symbol text,
  scanner_lane text not null,
  pool_created_at timestamptz,
  age_minutes numeric,
  liquidity_usd numeric,
  market_cap_usd numeric,
  volume_24h numeric,
  volume_1h numeric,
  volume_5m numeric,
  fee_tvl_24h_pct numeric,
  fee_tvl_1h_pct numeric,
  fee_tvl_5m_pct numeric,
  volume_spike_ratio numeric,
  momentum_score numeric,
  is_blacklisted boolean not null default false,
  last_seen_at timestamptz not null default now(),
  last_scanned_at timestamptz,
  next_scan_after timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.scanner_pool_cache add column if not exists pool_address text;
alter table public.scanner_pool_cache add column if not exists token_address text;
alter table public.scanner_pool_cache add column if not exists symbol text;
alter table public.scanner_pool_cache add column if not exists scanner_lane text;
alter table public.scanner_pool_cache add column if not exists pool_created_at timestamptz;
alter table public.scanner_pool_cache add column if not exists age_minutes numeric;
alter table public.scanner_pool_cache add column if not exists liquidity_usd numeric;
alter table public.scanner_pool_cache add column if not exists market_cap_usd numeric;
alter table public.scanner_pool_cache add column if not exists volume_24h numeric;
alter table public.scanner_pool_cache add column if not exists volume_1h numeric;
alter table public.scanner_pool_cache add column if not exists volume_5m numeric;
alter table public.scanner_pool_cache add column if not exists fee_tvl_24h_pct numeric;
alter table public.scanner_pool_cache add column if not exists fee_tvl_1h_pct numeric;
alter table public.scanner_pool_cache add column if not exists fee_tvl_5m_pct numeric;
alter table public.scanner_pool_cache add column if not exists volume_spike_ratio numeric;
alter table public.scanner_pool_cache add column if not exists momentum_score numeric;
alter table public.scanner_pool_cache add column if not exists is_blacklisted boolean not null default false;
alter table public.scanner_pool_cache add column if not exists last_seen_at timestamptz not null default now();
alter table public.scanner_pool_cache add column if not exists last_scanned_at timestamptz;
alter table public.scanner_pool_cache add column if not exists next_scan_after timestamptz;
alter table public.scanner_pool_cache add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.scanner_pool_cache add column if not exists created_at timestamptz not null default now();
alter table public.scanner_pool_cache add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_scanner_pool_cache_updated_at on public.scanner_pool_cache;
create trigger set_scanner_pool_cache_updated_at
before update on public.scanner_pool_cache
for each row execute function public.set_updated_at();

create unique index if not exists idx_scanner_pool_cache_pool_lane_unique
  on public.scanner_pool_cache (pool_address, scanner_lane);
create index if not exists idx_scanner_pool_cache_lane_next_scan
  on public.scanner_pool_cache (scanner_lane, next_scan_after asc nulls first);
create index if not exists idx_scanner_pool_cache_token_lane
  on public.scanner_pool_cache (token_address, scanner_lane);
create index if not exists idx_scanner_pool_cache_volume_5m
  on public.scanner_pool_cache (volume_5m desc);
create index if not exists idx_scanner_pool_cache_pool_created_at
  on public.scanner_pool_cache (pool_created_at desc);
create index if not exists idx_scanner_pool_cache_metadata_gin
  on public.scanner_pool_cache using gin (metadata);

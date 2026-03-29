-- Meteoracle initial schema
-- Run this in the Supabase SQL editor

create extension if not exists "uuid-ossp";

-- Positions: active and historical LP positions
create table if not exists positions (
  id uuid primary key default uuid_generate_v4(),
  token_symbol text not null,
  token_address text not null,
  pool_address text not null,
  strategy_id text not null,
  bin_range_lower numeric not null,
  bin_range_upper numeric not null,
  entry_price numeric not null,
  current_price numeric,
  sol_deposited numeric not null default 0,
  fees_earned_sol numeric not null default 0,
  status text not null default 'active' check (status in ('active', 'out_of_range', 'closed', 'error')),
  in_range boolean not null default true,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  pnl_sol numeric,
  metadata jsonb
);

-- Candidates: tokens that passed scanner filters
create table if not exists candidates (
  id uuid primary key default uuid_generate_v4(),
  token_address text not null,
  symbol text not null,
  score integer not null default 0,
  strategy_matched text,
  mc_at_scan numeric,
  volume_24h numeric,
  holder_count integer,
  rugcheck_score integer,
  top_holder_pct numeric,
  scanned_at timestamptz not null default now()
);

-- Bot logs: event log for all bot actions
create table if not exists bot_logs (
  id uuid primary key default uuid_generate_v4(),
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  event text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Indexes
create index on positions (status);
create index on positions (token_address);
create index on positions (opened_at desc);
create index on candidates (scanned_at desc);
create index on candidates (strategy_matched);
create index on bot_logs (created_at desc);
create index on bot_logs (level);

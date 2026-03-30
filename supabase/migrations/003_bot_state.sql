-- Migration 003: bot_state
-- Adds a single-row control table for runtime bot state.
-- Run this in the Supabase SQL Editor.

create table if not exists bot_state (
  id         integer primary key default 1,
  enabled    boolean     not null default true,
  dry_run    boolean     not null default true,
  updated_at timestamptz not null default now()
);

-- Enforce single-row constraint
alter table bot_state
  add constraint bot_state_single_row check (id = 1);

-- Seed the one allowed row (no-op if it already exists)
insert into bot_state (id, enabled, dry_run)
values (1, true, true)
on conflict (id) do nothing;

-- Auto-update updated_at on every write
create or replace function update_bot_state_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_bot_state_updated_at on bot_state;
create trigger trg_bot_state_updated_at
  before update on bot_state
  for each row execute procedure update_bot_state_updated_at();

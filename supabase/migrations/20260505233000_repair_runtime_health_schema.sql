-- Runtime health schema repair for deployed databases that predate
-- persistent sync failure tracking and scanner heartbeats.

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

create table if not exists public.bot_state (
  id integer primary key default 1,
  enabled boolean not null default false,
  dry_run boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_state_singleton check (id = 1)
);

alter table public.bot_state add column if not exists is_running boolean not null default false;
alter table public.bot_state add column if not exists running_since timestamptz;
alter table public.bot_state add column if not exists sync_fail_count integer not null default 0;

insert into public.bot_state (id, enabled, dry_run, is_running, sync_fail_count)
values (1, false, true, false, 0)
on conflict (id) do nothing;

create table if not exists public.bot_health (
  service text primary key,
  last_scan_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bot_health add column if not exists service text;
alter table public.bot_health add column if not exists last_scan_at timestamptz;
alter table public.bot_health add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.bot_health add column if not exists created_at timestamptz not null default now();
alter table public.bot_health add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_bot_health_updated_at on public.bot_health;
create trigger set_bot_health_updated_at
before update on public.bot_health
for each row execute function public.set_updated_at();

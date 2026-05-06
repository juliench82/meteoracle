-- Cross-process RPC provider cooldown flags.
-- PM2 services read this once at tick start and write it only after a provider 429.

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

create table if not exists public.rpc_provider_cooldowns (
  provider text primary key,
  cooldown_until timestamptz,
  last_status integer,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rpc_provider_cooldowns add column if not exists cooldown_until timestamptz;
alter table public.rpc_provider_cooldowns add column if not exists last_status integer;
alter table public.rpc_provider_cooldowns add column if not exists last_error text;
alter table public.rpc_provider_cooldowns add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.rpc_provider_cooldowns add column if not exists created_at timestamptz not null default now();
alter table public.rpc_provider_cooldowns add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_rpc_provider_cooldowns_until
on public.rpc_provider_cooldowns (cooldown_until desc);

drop trigger if exists set_rpc_provider_cooldowns_updated_at on public.rpc_provider_cooldowns;
create trigger set_rpc_provider_cooldowns_updated_at
before update on public.rpc_provider_cooldowns
for each row execute function public.set_updated_at();

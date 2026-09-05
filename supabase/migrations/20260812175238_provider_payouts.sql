-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812175238 · provider_payouts

-- What the platform has actually paid a provider.
--
-- Until now nothing recorded it. Revenue could be computed from the
-- subscription tables and the admin's Net Profit page split it into the
-- platform's take and the rest, but "the rest" was never written down
-- anywhere, so neither side could answer "what am I owed" with a number that
-- came from the same place twice.
--
-- One row per transfer. Earned − paid = outstanding; that subtraction is the
-- whole point of the table, so amounts are stored in cents like every other
-- money column here and a payout must be positive.

create table if not exists public.provider_payouts (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null references public.providers(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  currency     text not null default 'USD',
  -- The service period this settles, when it settles one. Null for an ad-hoc
  -- transfer — better than inventing a period nobody agreed on.
  period_start date,
  period_end   date,
  method       text,
  reference    text,
  note         text,
  paid_at      timestamptz not null default now(),
  created_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists provider_payouts_provider_idx
  on public.provider_payouts (provider_id, paid_at desc);

comment on table public.provider_payouts is
  'Money the platform has sent a provider. Written only through the NestJS admin API with the service role — never from the browser, unlike the config tables.';
comment on column public.provider_payouts.period_end is
  'Inclusive last day of the settled period. Null for an ad-hoc payout.';
comment on column public.provider_payouts.reference is
  'Lightning payment hash, on-chain txid, PayPal id — whatever proves it left.';

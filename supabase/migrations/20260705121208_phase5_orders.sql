-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705121208 · phase5_orders

-- Phase 5: Order domain — the transaction/saga aggregate that ties Booking,
-- Billing and Membership together. `lines` holds the fulfillment refs
-- (booking hold ids / subscription ids) the saga acts on when payment lands.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  subject_ref text,
  status text not null default 'pending_payment',  -- draft|pending_payment|confirmed|completed|cancelled|refunded
  amount_cents int,
  currency text not null default 'USD',
  lines jsonb not null default '[]'::jsonb,         -- [{ kind:'booking'|'subscription', ref:'…' }]
  payment_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_subject_idx on public.orders (subject_ref);
create index if not exists orders_status_idx on public.orders (status);
alter table public.orders enable row level security;

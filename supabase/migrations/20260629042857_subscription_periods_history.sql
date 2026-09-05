-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260629042857 · subscription_periods_history

create table if not exists public.subscription_periods (
  id uuid primary key default gen_random_uuid(),
  service text not null,
  subscription_id text not null,
  user_id text,
  customer_name text,
  plan_name text,
  started_at date,
  end_date date,
  amount_cents integer not null default 0,
  payment_method text,
  payment_status text,
  source text,
  recorded_at timestamptz not null default now()
);
create index if not exists subscription_periods_sub_idx on public.subscription_periods (service, subscription_id, recorded_at desc);
alter table public.subscription_periods enable row level security;

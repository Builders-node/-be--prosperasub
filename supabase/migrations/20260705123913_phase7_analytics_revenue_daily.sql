-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705123913 · phase7_analytics_revenue_daily

-- Phase 7: richer Analytics projection — revenue by day × method, event-sourced
-- from billing.PaymentCaptured. Pure read model, rebuildable by replay.
create table if not exists public.analytics_revenue_daily (
  day date not null,
  method text not null default 'unknown',
  revenue_cents int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, method)
);
alter table public.analytics_revenue_daily enable row level security;

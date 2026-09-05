-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705122737 · phase7_analytics_event_counts

-- Phase 7: Analytics domain — a pure event-sourced read model. A subscriber
-- rolls up every domain event into per-type/day counts. No writes back to any
-- domain; rebuildable by replaying the event log.
create table if not exists public.analytics_event_counts (
  event_type text not null,
  day date not null,
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (event_type, day)
);
alter table public.analytics_event_counts enable row level security;

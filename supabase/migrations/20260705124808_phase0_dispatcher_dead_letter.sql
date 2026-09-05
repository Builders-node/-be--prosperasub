-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705124808 · phase0_dispatcher_dead_letter

-- Dispatcher hardening: track per-(event,consumer) delivery status + attempts so
-- a permanently-failing handler dead-letters after MAX attempts instead of
-- wedging the event forever. Existing rows are successful deliveries.
alter table public.domain_event_deliveries
  add column if not exists status text not null default 'delivered',   -- delivered | failed | dead
  add column if not exists attempts int not null default 1,
  add column if not exists last_error text,
  add column if not exists updated_at timestamptz not null default now();

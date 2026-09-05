-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705123313 · phase7b_notification_log

-- Phase 7b: Notification domain — a pure subscriber that turns domain events
-- into notification intents. Records intents (does NOT send yet — real channel
-- delivery + dedup vs the existing direct path is a later step).
create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  subject_ref text,
  channel text not null default 'inapp',
  status text not null default 'queued',   -- queued | sent | failed
  created_at timestamptz not null default now()
);
create index if not exists notification_log_subject_idx on public.notification_log (subject_ref);
alter table public.notification_log enable row level security;

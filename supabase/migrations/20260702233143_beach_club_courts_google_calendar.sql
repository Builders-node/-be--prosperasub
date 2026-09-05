-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260702233143 · beach_club_courts_google_calendar

alter table public.beach_club_courts
  add column if not exists google_calendar_id text;
alter table public.beach_club_court_bookings
  add column if not exists google_calendar_event_id text,
  add column if not exists google_calendar_sync_status text,
  add column if not exists google_calendar_sync_error text;

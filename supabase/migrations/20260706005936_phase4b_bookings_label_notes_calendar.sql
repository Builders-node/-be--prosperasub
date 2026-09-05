-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706005936 · phase4b_bookings_label_notes_calendar

-- Extend Booking aggregate for admin use — display label (member_name), notes,
-- and the Google Calendar link so calendar sync can operate on the engine table.
alter table public.bookings
  add column if not exists label text,
  add column if not exists notes text,
  add column if not exists google_calendar_event_id text,
  add column if not exists google_calendar_sync_status text;

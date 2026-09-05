-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260703022615 · beach_court_bookings_source_sync

alter table public.beach_club_court_bookings
  add column if not exists source text not null default 'admin',
  add column if not exists updated_at timestamptz not null default now();

alter table public.beach_club_courts
  add column if not exists google_last_synced_at timestamptz;

create unique index if not exists beach_court_bookings_gcal_evt_uidx
  on public.beach_club_court_bookings (google_calendar_event_id)
  where google_calendar_event_id is not null;

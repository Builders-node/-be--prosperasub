alter table public.cleaning_bookings
  add column if not exists google_calendar_event_id text,
  add column if not exists google_calendar_event_link text,
  add column if not exists google_calendar_synced_at timestamptz,
  add column if not exists google_calendar_sync_status text not null default 'pending',
  add column if not exists google_calendar_sync_error text;

create index if not exists cleaning_bookings_google_calendar_sync_status_idx
  on public.cleaning_bookings (google_calendar_sync_status);

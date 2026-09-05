-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260702230539 · beach_club_courts_config

alter table public.beach_club_courts
  add column if not exists open_hour integer not null default 8,
  add column if not exists close_hour integer not null default 19,
  add column if not exists slot_minutes integer not null default 60,
  add column if not exists description text;
alter table public.beach_club_courts
  add constraint beach_club_courts_hours_chk check (open_hour >= 0 and open_hour < close_hour and close_hour <= 24);

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260702231109 · beach_club_courts_ical

alter table public.beach_club_courts
  add column if not exists external_ics_url text,
  add column if not exists ical_feed_token uuid not null default gen_random_uuid();

create unique index if not exists beach_club_courts_ical_feed_token_idx
  on public.beach_club_courts (ical_feed_token);

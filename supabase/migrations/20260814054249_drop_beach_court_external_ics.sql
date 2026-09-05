-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814054249 · drop_beach_court_external_ics

-- The "read an outside calendar in" side of the Pristine Bay integration. It
-- was write-only from the start: the admin form stored a URL and nothing ever
-- rendered events from it, and no court had one set. Our own feed OUT
-- (`ical_feed_token`) and the platform-owned Google calendar stay.
alter table beach_club_courts drop column if exists external_ics_url;

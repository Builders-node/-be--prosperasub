-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811002740 · providers_google_calendar_id

-- Each provider gets its own Google Calendar, the way each beach court already
-- does. Cleaning pushed every booking into one shared calendar
-- (GOOGLE_CLEANING_CALENDAR_ID), so a car wash and an apartment clean landed
-- side by side with nothing but the plan name in the description to tell them
-- apart — and the cleaners of one business saw the schedule of the other.
--
-- google_calendar.service already accepts a per-call calendar id and falls back
-- to the shared one; the cleaning sync simply never passed it. Nullable, so a
-- provider without its own calendar keeps using the shared one and nothing
-- changes for it.

alter table providers
  add column if not exists google_calendar_id text;

comment on column providers.google_calendar_id is
  'Google Calendar this provider''s bookings sync to. NULL = the shared calendar from GOOGLE_CLEANING_CALENDAR_ID. Same idea as beach_club_courts.google_calendar_id.';

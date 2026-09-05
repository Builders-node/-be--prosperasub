-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814195844 · cleaning_bookings_record_target_calendar

-- Remember WHICH calendar a booking's event was written to.
--
-- The sync stores an event id but not the calendar it belongs to, and a Google
-- event id is only addressable on its own calendar. So the moment a provider
-- gets a calendar of its own, every event it already has becomes unreachable:
-- the update 404s, the search finds nothing, and a fresh event is created on
-- the new calendar while the old one sits on the shared one forever. Thirteen
-- car washes are about to do exactly that.
--
-- With the calendar recorded, the sync can see that a booking has moved and
-- delete the event where it actually is before writing it where it now
-- belongs.
--
-- Backfill is unambiguous: all 155 events on the platform are on the one shared
-- calendar -- decoding the `eid` of every stored link gives exactly one
-- calendar id.
alter table public.cleaning_bookings
  add column if not exists google_calendar_id text;

update public.cleaning_bookings
   set google_calendar_id = 'b49935fb05e54f1216f6d01dc2ea8e3095b75c7a347204dae7d230f20cc09b3c@group.calendar.google.com'
 where google_calendar_event_id is not null
   and google_calendar_id is null;

comment on column public.cleaning_bookings.google_calendar_id is
  'The calendar the stored event actually lives on. When it stops matching the provider''s resolved calendar, the event is deleted here and recreated there.';

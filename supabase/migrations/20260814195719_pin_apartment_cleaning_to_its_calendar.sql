-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814195719 · pin_apartment_cleaning_to_its_calendar

-- The shared calendar becomes Apartment Cleaning's own.
--
-- Every cleaning visit on the platform -- 146 apartment cleans and 13 car
-- washes -- lands in one calendar, because neither provider has a
-- `google_calendar_id` and `resolveCalendarId()` reads "no calendar" as "use
-- the shared one". Nothing was leaking anywhere: there is simply one calendar
-- and two businesses in it.
--
-- Apartment Cleaning is the business that calendar has always been about, so
-- it is named as its owner rather than left resolving there by accident. That
-- changes no behaviour today -- the same calendar id is reached either way --
-- but it means Car Wash getting a calendar of its own cannot quietly take this
-- one with it.
--
-- The id is the value of GOOGLE_CLEANING_CALENDAR_ID; it is also decodable
-- from every event link already stored on the bookings, all 155 of which point
-- at this one calendar.
update public.providers
   set google_calendar_id = 'b49935fb05e54f1216f6d01dc2ea8e3095b75c7a347204dae7d230f20cc09b3c@group.calendar.google.com',
       updated_at = now()
 where source_service_key = 'cleaning'
   and source_provider_id = '24f02cc2-0c83-489d-8804-3ff9347005b7'
   and google_calendar_id is null;

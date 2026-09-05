-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260805192644 · allow_client_only_cleaning_bookings

-- A cleaning subscription can belong to a business CLIENT rather than an app
-- user — 2 of 19 live subscriptions are like that (Cowork Apartment). But
-- cleaning_bookings.user_id was NOT NULL, so those subscriptions could not be
-- scheduled at all: the admin's New booking dialog passed the subscription's
-- null user_id straight through and Postgres rejected every visit with
-- "null value in column user_id violates not-null constraint".
--
-- Every reader already copes with a missing user:
--   • account-cleaning syncOwnBooking compares String(user_id) to the session
--     id, so null simply never matches — access stays closed.
--   • cleaning-reminder resolveRecipientUserId returns null and the row is
--     skipped; there is no app user to remind.
--   • the calendar sync filters on a truthy user_id and already falls back to
--     cleaning_clients.company_name for the event title.
--
-- The NOT NULL was the only thing out of step. Replaced with a check that a
-- booking still names SOMEONE, so this can't become a row belonging to nobody.
alter table public.cleaning_bookings
  alter column user_id drop not null;

alter table public.cleaning_bookings
  drop constraint if exists cleaning_bookings_has_owner;

alter table public.cleaning_bookings
  add constraint cleaning_bookings_has_owner
  check (user_id is not null or client_id is not null);

comment on column public.cleaning_bookings.user_id is
  'App user who owns the visit. NULL for a business-client booking — cleaning_clients.client_id identifies it instead. The cleaning_bookings_has_owner check guarantees one of the two is set.';

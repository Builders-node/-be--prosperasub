-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902232535 · rental_bookings_no_double_booking

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- One car cannot be in two places.
--
-- Until now the only thing stopping a double booking was a re-read of
-- availability in the browser, inside reserve(). Two people pressing Book at
-- the same second both passed that check and both rows were written: nothing
-- between them and the same car. A subscription can be sold to everybody at
-- once — a physical object cannot, and the platform had no way to say so.
--
-- Inclusive on both ends ('[]') to match `overlapsHeld`, which treats a booking
-- ending on the day another starts as a clash. Same-day return and handover of
-- one car is not a thing anyone should be sold.
--
-- Scoped to live rows: a cancelled or deleted booking holds nothing, and stale
-- pending holds are cancelled by rental_bookings_release_stale_holds before
-- this is evaluated.
ALTER TABLE rental_bookings
  ADD CONSTRAINT rental_bookings_no_overlap
  EXCLUDE USING gist (
    vehicle_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (deleted_at IS NULL AND lower(status) NOT IN ('cancelled', 'canceled'));

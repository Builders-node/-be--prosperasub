-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902232523 · rental_release_stale_holds

-- Release abandoned checkouts before a new booking is checked against them.
--
-- The overlap constraint added next is static: it cannot ask what time it is,
-- so it treats every live booking as holding the car. Without this, someone who
-- opened the booking page and wandered off would block that car for ever.
--
-- The thresholds are the ones the storefront already uses to grey out dates
-- (lib/vehicles/availability.ts). They have to be the same two numbers, or the
-- calendar would offer a date the insert then refuses:
--   paid / confirmed / active / completed → held, no expiry
--   pending WITH a payment reference      → 24h, as long as the server retries
--   pending with no reference at all      → 20 minutes, time to finish the form
--
-- Cancelling rather than deleting: a booking that was abandoned still happened,
-- and the occurrence mirror turns the cancellation into cancelled jobs.
CREATE OR REPLACE FUNCTION rental_release_stale_holds()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE rental_bookings b
     SET status = 'cancelled',
         admin_notes = concat_ws(' · ', nullif(b.admin_notes, ''), 'Hold expired'),
         updated_at = now()
   WHERE b.vehicle_id = NEW.vehicle_id
     AND b.id IS DISTINCT FROM NEW.id
     AND b.deleted_at IS NULL
     AND lower(b.status) NOT IN ('cancelled', 'canceled')
     AND b.payment_status <> 'paid'
     AND lower(b.status) NOT IN ('confirmed', 'active', 'completed')
     AND b.created_at IS NOT NULL
     AND b.created_at < now() - CASE
           WHEN nullif(b.payment_reference, '') IS NOT NULL THEN interval '24 hours'
           ELSE interval '20 minutes'
         END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rental_bookings_release_stale_holds ON rental_bookings;
CREATE TRIGGER rental_bookings_release_stale_holds
  BEFORE INSERT ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION rental_release_stale_holds();

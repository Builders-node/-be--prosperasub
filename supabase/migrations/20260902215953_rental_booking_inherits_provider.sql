-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902215953 · rental_booking_inherits_provider

-- Writers of rental_bookings are scattered — the storefront checkout, the
-- admin, the reconcile cron — and none of them should have to know which
-- business owns the car. The row learns it from the vehicle, the way
-- provider_plans_classify fills a plan's mode when a writer leaves it null.
--
-- Only fills a NULL: an explicit provider_id (a car moved between businesses,
-- a correction) is left exactly as written.
CREATE OR REPLACE FUNCTION rental_booking_inherit_provider()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider_id IS NULL AND NEW.vehicle_id IS NOT NULL THEN
    SELECT v.provider_id INTO NEW.provider_id
      FROM rental_vehicles v
     WHERE v.id = NEW.vehicle_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rental_bookings_inherit_provider ON rental_bookings;
CREATE TRIGGER rental_bookings_inherit_provider
  BEFORE INSERT OR UPDATE OF vehicle_id ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION rental_booking_inherit_provider();

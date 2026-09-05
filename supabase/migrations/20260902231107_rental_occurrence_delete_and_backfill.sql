-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902231107 · rental_occurrence_delete_and_backfill

-- A hard-deleted booking must not leave its two occurrences behind. Rentals
-- normally soft-delete (deleted_at), which the mirror already turns into
-- cancelled; this covers the real DELETE.
CREATE OR REPLACE FUNCTION delete_mirrored_occurrence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  key text;
BEGIN
  key := CASE TG_TABLE_NAME
           WHEN 'cleaning_bookings'          THEN 'cleaning'
           WHEN 'food_delivery_logs'         THEN 'food'
           WHEN 'beach_club_court_bookings'  THEN 'beach'
           WHEN 'rental_bookings'            THEN 'vehicles'
         END;
  IF key IS NULL THEN
    RETURN OLD;
  END IF;

  -- Deletes BOTH of a rental's rows: they share the source record id.
  DELETE FROM service_occurrences
   WHERE source_service_key = key
     AND source_record_id IS NOT NULL
     AND source_record_id::text = OLD.id::text;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS rental_bookings_delete_occurrence ON rental_bookings;
CREATE TRIGGER rental_bookings_delete_occurrence
  AFTER DELETE ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION delete_mirrored_occurrence();

-- Bookings that predate the mirror. A no-op update fires the AFTER trigger
-- without moving updated_at, so nothing else reads as freshly changed.
UPDATE rental_bookings SET updated_at = updated_at;

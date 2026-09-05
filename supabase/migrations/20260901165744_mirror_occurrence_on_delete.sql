-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260901165744 · mirror_occurrence_on_delete


-- The occurrence mirror handled INSERT and UPDATE but never DELETE, so a
-- deleted legacy booking left its occurrence behind for ever. Those ghosts
-- show up in the provider's "Today's work" as visits nobody will make — two of
-- them were sitting under one customer's name on 2026-09-01.
CREATE OR REPLACE FUNCTION delete_mirrored_occurrence() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key text;
BEGIN
  key := CASE TG_TABLE_NAME
           WHEN 'cleaning_bookings'          THEN 'cleaning'
           WHEN 'food_delivery_logs'         THEN 'food'
           WHEN 'beach_club_court_bookings'  THEN 'beach'
         END;
  IF key IS NULL THEN
    RETURN OLD;
  END IF;

  DELETE FROM service_occurrences
   WHERE source_service_key = key
     AND source_record_id IS NOT NULL
     AND source_record_id::text = OLD.id::text;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS unmirror_occurrence_cleaning ON public.cleaning_bookings;
CREATE TRIGGER unmirror_occurrence_cleaning
  AFTER DELETE ON public.cleaning_bookings
  FOR EACH ROW EXECUTE FUNCTION delete_mirrored_occurrence();

DROP TRIGGER IF EXISTS unmirror_occurrence_food_delivery ON public.food_delivery_logs;
CREATE TRIGGER unmirror_occurrence_food_delivery
  AFTER DELETE ON public.food_delivery_logs
  FOR EACH ROW EXECUTE FUNCTION delete_mirrored_occurrence();

DROP TRIGGER IF EXISTS unmirror_occurrence_beach_court ON public.beach_club_court_bookings;
CREATE TRIGGER unmirror_occurrence_beach_court
  AFTER DELETE ON public.beach_club_court_bookings
  FOR EACH ROW EXECUTE FUNCTION delete_mirrored_occurrence();

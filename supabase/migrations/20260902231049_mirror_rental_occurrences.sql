-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902231049 · mirror_rental_occurrences

-- A rental is two jobs, not one.
--
-- Every other service mirrors one legacy record to one occurrence: a visit, a
-- delivery, an hour on a court. A rental is a car leaving and a car coming
-- back, days apart, and both are work somebody has to turn up for. Collapsing
-- them into a single row would put the return nowhere — which is exactly the
-- job most likely to be forgotten.
--
-- It also lets the two carry different states: while a rental is `active` the
-- handover is done and the return is still ahead, so "Today's work" can say
-- "collect the Hyundai" without anything else being asked of it.
CREATE OR REPLACE FUNCTION mirror_rental_occurrences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user     uuid;
  v_start    timestamptz;
  v_end      timestamptz;
  v_handover text;
  v_return   text;
  v_car      text;
  v_notes    text;
BEGIN
  IF NEW.provider_id IS NULL THEN RETURN NEW; END IF;

  -- user_id is text here and can hold a Google-sub id, which is no uuid.
  v_user := CASE
    WHEN NEW.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN NEW.user_id::uuid ELSE NULL END;

  v_start := (NEW.start_date::timestamp + NEW.start_time) AT TIME ZONE 'America/Tegucigalpa';
  v_end   := (NEW.end_date::timestamp   + NEW.end_time)   AT TIME ZONE 'America/Tegucigalpa';

  IF NEW.deleted_at IS NOT NULL
     OR lower(coalesce(NEW.status, '')) IN ('cancelled', 'canceled') THEN
    v_handover := 'cancelled'; v_return := 'cancelled';
  ELSIF lower(coalesce(NEW.status, '')) = 'completed' THEN
    v_handover := 'done';      v_return := 'done';
  ELSIF lower(coalesce(NEW.status, '')) = 'active' THEN
    -- The car is with the customer: handing it over already happened.
    v_handover := 'done';      v_return := 'scheduled';
  ELSE
    v_handover := 'scheduled'; v_return := 'scheduled';
  END IF;

  SELECT name INTO v_car FROM rental_vehicles WHERE id = NEW.vehicle_id;
  v_notes := concat_ws(' · ',
    coalesce(v_car, 'Car rental'),
    nullif(NEW.customer_name, ''),
    nullif(NEW.delivery_notes, ''));

  PERFORM mirror_rental_occurrence_one(
    NEW.id::text, NEW.provider_id, v_user, 'handover', v_start, v_handover,
    v_notes, nullif(NEW.delivery_address, ''));
  PERFORM mirror_rental_occurrence_one(
    NEW.id::text, NEW.provider_id, v_user, 'return', v_end, v_return,
    v_notes, nullif(NEW.delivery_address, ''));

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A mirror must never be the reason a booking fails to save.
  RAISE WARNING 'rental occurrence mirror failed for %: %', NEW.id, sqlerrm;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rental_bookings_mirror_occurrences ON rental_bookings;
CREATE TRIGGER rental_bookings_mirror_occurrences
  AFTER INSERT OR UPDATE ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION mirror_rental_occurrences();

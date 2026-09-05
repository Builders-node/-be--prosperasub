-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260901170941 · notify_rental_payment_received


-- Every other service tells the customer their money arrived; car rentals told
-- nobody but the team. This is the same idea as notify_payment_received, kept
-- separate because a rental's receipt has to point at the car storefront on
-- its own origin rather than /my-subscriptions.
CREATE OR REPLACE FUNCTION public.notify_rental_payment_received() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user     uuid;
  v_user_txt text;
  v_car      text;
BEGIN
  IF NEW.payment_status IS DISTINCT FROM 'paid' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.payment_status IS NOT DISTINCT FROM 'paid' THEN RETURN NEW; END IF;

  v_user_txt := nullif(NEW.user_id::text, '');
  IF v_user_txt IS NULL THEN RETURN NEW; END IF;
  -- user_notifications.recipient_user_id is a uuid; a Google-sub id has no row.
  IF v_user_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  v_user := v_user_txt::uuid;

  -- Said once, whichever path confirmed it: checkout, the webhook, or the cron.
  IF EXISTS (
    SELECT 1 FROM user_notifications n
     WHERE n.related_entity_id = NEW.id::text AND n.type = 'payment_received'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_car FROM rental_vehicles WHERE id = NEW.vehicle_id LIMIT 1;

  INSERT INTO user_notifications
    (recipient_user_id, category, type, title, body,
     related_entity_type, related_entity_id, action_url)
  VALUES (
    v_user, 'payment', 'payment_received',
    'Booking confirmed',
    'Your payment for ' || coalesce(v_car, 'your car rental') || ' is confirmed — '
      || to_char(NEW.start_date, 'Mon DD') || ' to ' || to_char(NEW.end_date, 'Mon DD') || '.',
    'car_rental', NEW.id::text,
    'https://vehicles.everysub.net/booking/' || NEW.id::text
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A receipt must never be the reason a payment fails to record.
  RAISE WARNING 'notify_rental_payment_received failed for %: %', NEW.id, sqlerrm;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rental_notify_payment_received ON public.rental_bookings;
CREATE TRIGGER rental_notify_payment_received
  AFTER INSERT OR UPDATE ON public.rental_bookings
  FOR EACH ROW EXECUTE FUNCTION public.notify_rental_payment_received();

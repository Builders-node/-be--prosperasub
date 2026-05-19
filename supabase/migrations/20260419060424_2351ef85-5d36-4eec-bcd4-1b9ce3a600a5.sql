CREATE OR REPLACE FUNCTION public.book_cleaning_slot(p_subscription_id uuid, p_slot_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_remaining INTEGER;
  v_max_bookings INTEGER;
  v_current_bookings INTEGER;
  v_booking_id UUID;
  v_slot_date DATE;
  v_week_start DATE;
  v_week_end DATE;
  v_user_week_count INTEGER;
  v_day_total_count INTEGER;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Subscription check
  SELECT cs.cleanings_remaining INTO v_remaining
  FROM cleaning_subscriptions cs
  WHERE cs.id = p_subscription_id
    AND cs.user_id = v_user_id
    AND cs.is_active = true;

  IF v_remaining IS NULL THEN
    RAISE EXCEPTION 'Subscription not found or inactive';
  END IF;

  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'No cleanings remaining';
  END IF;

  -- Slot check
  SELECT s.max_bookings, s.current_bookings, s.date
  INTO v_max_bookings, v_current_bookings, v_slot_date
  FROM cleaning_available_slots s
  WHERE s.id = p_slot_id AND s.date >= CURRENT_DATE;

  IF v_max_bookings IS NULL THEN
    RAISE EXCEPTION 'Slot not found or in the past';
  END IF;

  IF v_current_bookings >= v_max_bookings THEN
    RAISE EXCEPTION 'Slot is fully booked';
  END IF;

  -- No Sunday bookings (ISO: 0=Sunday in PG dow)
  IF EXTRACT(DOW FROM v_slot_date) = 0 THEN
    RAISE EXCEPTION 'Cleaning service is not available on Sundays';
  END IF;

  -- 1 booking per ISO week (Mon-Sun) per user
  v_week_start := date_trunc('week', v_slot_date)::date; -- Monday
  v_week_end := v_week_start + 6;
  SELECT COUNT(*) INTO v_user_week_count
  FROM cleaning_bookings cb
  JOIN cleaning_available_slots cs ON cs.id = cb.slot_id
  WHERE cb.user_id = v_user_id
    AND cb.status = 'booked'
    AND cs.date BETWEEN v_week_start AND v_week_end;

  IF v_user_week_count >= 1 THEN
    RAISE EXCEPTION 'You already have a cleaning booked this week. Limit is 1 per week.';
  END IF;

  -- Max 3 cleanings per day across all users
  SELECT COUNT(*) INTO v_day_total_count
  FROM cleaning_bookings cb
  JOIN cleaning_available_slots cs ON cs.id = cb.slot_id
  WHERE cs.date = v_slot_date
    AND cb.status = 'booked';

  IF v_day_total_count >= 3 THEN
    RAISE EXCEPTION 'This day is fully booked (max 3 cleanings/day).';
  END IF;

  -- Create booking
  INSERT INTO cleaning_bookings (subscription_id, slot_id, user_id, notes)
  VALUES (p_subscription_id, p_slot_id, v_user_id, p_notes)
  RETURNING id INTO v_booking_id;

  UPDATE cleaning_subscriptions
  SET cleanings_remaining = cleanings_remaining - 1, updated_at = now()
  WHERE id = p_subscription_id;

  UPDATE cleaning_available_slots
  SET current_bookings = current_bookings + 1, updated_at = now()
  WHERE id = p_slot_id;

  RETURN v_booking_id;
END;
$function$;
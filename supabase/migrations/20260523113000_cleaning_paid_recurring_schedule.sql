ALTER TABLE public.cleaning_subscriptions
  ADD COLUMN IF NOT EXISTS billing_period_months INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS total_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS service_start_date DATE,
  ADD COLUMN IF NOT EXISTS service_end_date DATE,
  ADD COLUMN IF NOT EXISTS paid_until DATE,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'pending_payment',
  ADD COLUMN IF NOT EXISTS apartment_note TEXT,
  ADD COLUMN IF NOT EXISTS recurring_day_of_week INTEGER,
  ADD COLUMN IF NOT EXISTS recurring_time TIME;

ALTER TABLE public.cleaning_bookings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user_single_booking';

CREATE INDEX IF NOT EXISTS cleaning_subscriptions_user_status_idx
  ON public.cleaning_subscriptions (user_id, payment_status, subscription_status);

CREATE INDEX IF NOT EXISTS cleaning_bookings_subscription_status_idx
  ON public.cleaning_bookings (subscription_id, status);

CREATE OR REPLACE FUNCTION public.schedule_cleaning_subscription(
  p_subscription_id UUID,
  p_day_of_week INTEGER,
  p_start_time TIME,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_subscription cleaning_subscriptions%ROWTYPE;
  v_package_cleanings_per_month INTEGER;
  v_period_start DATE;
  v_period_end DATE;
  v_conflict_date DATE;
  v_created_count INTEGER := 0;
  v_purchased_cleanings INTEGER := 0;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_day_of_week IS NULL OR p_day_of_week < 1 OR p_day_of_week > 6 THEN
    RAISE EXCEPTION 'Choose a weekday from Monday to Saturday';
  END IF;

  IF NULLIF(BTRIM(p_notes), '') IS NULL THEN
    RAISE EXCEPTION 'Apartment / access notes are required';
  END IF;

  SELECT cs.*
  INTO v_subscription
  FROM public.cleaning_subscriptions cs
  WHERE cs.id = p_subscription_id
    AND cs.user_id = v_user_id
  FOR UPDATE;

  IF v_subscription.id IS NULL THEN
    RAISE EXCEPTION 'Cleaning subscription not found';
  END IF;

  IF v_subscription.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Payment must be completed before scheduling';
  END IF;

  IF COALESCE(v_subscription.subscription_status, '') NOT IN ('pending_schedule', 'active') THEN
    RAISE EXCEPTION 'This cleaning subscription cannot be scheduled';
  END IF;

  v_period_start := GREATEST(
    COALESCE(v_subscription.service_start_date, v_subscription.start_date, CURRENT_DATE),
    CURRENT_DATE
  );
  v_period_end := COALESCE(v_subscription.paid_until, v_subscription.service_end_date, v_subscription.end_date);

  IF v_period_end IS NULL OR v_period_end < v_period_start THEN
    RAISE EXCEPTION 'Cleaning service period is invalid';
  END IF;

  CREATE TEMP TABLE tmp_cleaning_schedule_dates ON COMMIT DROP AS
  SELECT generated_date::date AS service_date
  FROM generate_series(v_period_start, v_period_end, INTERVAL '1 day') AS generated_date
  WHERE EXTRACT(DOW FROM generated_date) = p_day_of_week;

  IF NOT EXISTS (SELECT 1 FROM tmp_cleaning_schedule_dates) THEN
    RAISE EXCEPTION 'No future cleanings match this schedule';
  END IF;

  CREATE TEMP TABLE tmp_old_future_bookings ON COMMIT DROP AS
  SELECT cb.id, cb.slot_id
  FROM public.cleaning_bookings cb
  JOIN public.cleaning_available_slots cas ON cas.id = cb.slot_id
  WHERE cb.subscription_id = p_subscription_id
    AND cb.status = 'booked'
    AND cas.date >= CURRENT_DATE;

  CREATE TEMP TABLE tmp_target_cleaning_slots ON COMMIT DROP AS
  SELECT dates.service_date, slots.id AS slot_id, slots.current_bookings, slots.max_bookings
  FROM tmp_cleaning_schedule_dates dates
  LEFT JOIN public.cleaning_available_slots slots
    ON slots.date = dates.service_date
   AND slots.start_time = p_start_time;

  SELECT service_date
  INTO v_conflict_date
  FROM tmp_target_cleaning_slots target
  WHERE target.slot_id IS NULL
     OR (
       target.current_bookings >= target.max_bookings
       AND NOT EXISTS (
         SELECT 1
         FROM tmp_old_future_bookings old_booking
         WHERE old_booking.slot_id = target.slot_id
       )
     )
  ORDER BY service_date
  LIMIT 1;

  IF v_conflict_date IS NOT NULL THEN
    RAISE EXCEPTION 'The selected time is not available for every week. First conflict: %', v_conflict_date;
  END IF;

  UPDATE public.cleaning_available_slots slots
  SET current_bookings = GREATEST(slots.current_bookings - old_counts.booking_count, 0),
      updated_at = now()
  FROM (
    SELECT slot_id, COUNT(*)::integer AS booking_count
    FROM tmp_old_future_bookings
    GROUP BY slot_id
  ) old_counts
  WHERE slots.id = old_counts.slot_id;

  UPDATE public.cleaning_bookings
  SET status = 'cancelled',
      updated_at = now()
  WHERE id IN (SELECT id FROM tmp_old_future_bookings);

  INSERT INTO public.cleaning_bookings (subscription_id, slot_id, user_id, notes, source)
  SELECT p_subscription_id, target.slot_id, v_user_id, BTRIM(p_notes), 'user_recurring_schedule'
  FROM tmp_target_cleaning_slots target
  ORDER BY target.service_date;

  GET DIAGNOSTICS v_created_count = ROW_COUNT;

  UPDATE public.cleaning_available_slots slots
  SET current_bookings = slots.current_bookings + new_counts.booking_count,
      updated_at = now()
  FROM (
    SELECT slot_id, COUNT(*)::integer AS booking_count
    FROM tmp_target_cleaning_slots
    GROUP BY slot_id
  ) new_counts
  WHERE slots.id = new_counts.slot_id;

  SELECT cp.cleanings_per_month
  INTO v_package_cleanings_per_month
  FROM public.cleaning_packages cp
  WHERE cp.id = v_subscription.package_id;

  v_purchased_cleanings :=
    COALESCE(v_package_cleanings_per_month, 4) * GREATEST(COALESCE(v_subscription.billing_period_months, 1), 1);

  UPDATE public.cleaning_subscriptions
  SET recurring_day_of_week = p_day_of_week,
      recurring_time = p_start_time,
      subscription_status = 'active',
      is_active = true,
      cleanings_remaining = GREATEST(v_purchased_cleanings - v_created_count, 0),
      updated_at = now()
  WHERE id = p_subscription_id;

  RETURN jsonb_build_object(
    'subscription_id', p_subscription_id,
    'bookings_created', v_created_count,
    'recurring_day_of_week', p_day_of_week,
    'recurring_time', p_start_time
  );
END;
$$;

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812060018 · fix_schedule_cleaning_subscription

-- The recurring scheduler was broken in two ways at once, and both of them
-- left a customer who had already paid unable to book anything.
--
-- 1. `slots.start_time = p_start_time` compares a TEXT column to a TIME
--    parameter. Postgres has no such operator, so the call raised
--        42883 operator does not exist: text = time without time zone
--    the moment anybody pressed confirm. The column must have been TIME when
--    this function was written; it is text now, and nothing re-checked.
--
-- 2. The slot lookup had no provider in it. Slots became per-provider on
--    2026-08-10, so `date = X and start_time = Y` now matches Car Wash's row,
--    Apartment Cleaning's row AND the legacy shared row — three of them for
--    2026-08-13 08:00 as this was written. The LEFT JOIN would have produced
--    three bookings per date and consumed capacity in two other providers'
--    grids. Nobody has scheduled since the migration, so this never fired;
--    the next customer would have been the first.
--
-- Also added: `is_active`. The booking page hides inactive slots, this did not,
-- so a customer could be scheduled into an hour the provider had switched off.
--
-- The provider is resolved the same way the booking page resolves it —
-- package → legacy provider → universal provider — with the same fallback: a
-- provider that keeps no grid of its own uses the shared rows.

create or replace function public.schedule_cleaning_subscription(
  p_subscription_id uuid,
  p_day_of_week integer,
  p_start_time time without time zone,
  p_notes text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_user_id UUID;
  v_subscription cleaning_subscriptions%ROWTYPE;
  v_package_cleanings_per_month INTEGER;
  v_period_start DATE;
  v_first_cleaning DATE;
  v_service_end DATE;
  v_billing_months INTEGER;
  v_conflict_date DATE;
  v_created_count INTEGER := 0;
  v_purchased_cleanings INTEGER := 0;
  v_provider_id UUID;
  v_start_txt TEXT;
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

  -- start_time is TEXT ('08:00:00'). Compare text to text, once, here.
  v_start_txt := to_char(p_start_time, 'HH24:MI:SS');

  -- Which grid this subscription books against. A provider that keeps no rows
  -- of its own still uses the legacy shared grid, exactly as the booking page
  -- decides it.
  SELECT pr.id INTO v_provider_id
  FROM public.cleaning_packages cp
  JOIN public.providers pr
    ON pr.source_provider_id = cp.provider_id
   AND pr.source_service_key = 'cleaning'
  WHERE cp.id = v_subscription.package_id;

  IF v_provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cleaning_available_slots s WHERE s.provider_id = v_provider_id
  ) THEN
    v_provider_id := NULL;
  END IF;

  -- How many cleanings were purchased
  SELECT cp.cleanings_per_month
  INTO v_package_cleanings_per_month
  FROM public.cleaning_packages cp
  WHERE cp.id = v_subscription.package_id;

  v_billing_months := GREATEST(COALESCE(v_subscription.billing_period_months, 1), 1);
  v_purchased_cleanings := COALESCE(v_package_cleanings_per_month, 4) * v_billing_months;

  -- Earliest a cleaning can happen: not before the paid service start, and never in the past.
  v_period_start := GREATEST(
    COALESCE(v_subscription.service_start_date, v_subscription.start_date, CURRENT_DATE),
    CURRENT_DATE
  );

  -- First cleaning = first matching weekday on/after v_period_start
  SELECT MIN(d)::date
  INTO v_first_cleaning
  FROM generate_series(v_period_start, v_period_start + INTERVAL '7 days', INTERVAL '1 day') AS d
  WHERE EXTRACT(DOW FROM d) = p_day_of_week;

  IF v_first_cleaning IS NULL THEN
    RAISE EXCEPTION 'No future cleanings match this schedule';
  END IF;

  v_service_end := v_first_cleaning + make_interval(months => v_billing_months);

  CREATE TEMP TABLE tmp_cleaning_schedule_dates ON COMMIT DROP AS
  SELECT d::date AS service_date
  FROM generate_series(
         v_first_cleaning,
         v_first_cleaning + (7 * v_purchased_cleanings) * INTERVAL '1 day',
         INTERVAL '1 day'
       ) AS d
  WHERE EXTRACT(DOW FROM d) = p_day_of_week
  ORDER BY d
  LIMIT v_purchased_cleanings;

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

  -- One slot per date: this provider's, active, at that time.
  CREATE TEMP TABLE tmp_target_cleaning_slots ON COMMIT DROP AS
  SELECT dates.service_date, slots.id AS slot_id, slots.current_bookings, slots.max_bookings
  FROM tmp_cleaning_schedule_dates dates
  LEFT JOIN public.cleaning_available_slots slots
    ON slots.date = dates.service_date
   AND slots.start_time = v_start_txt
   AND slots.provider_id IS NOT DISTINCT FROM v_provider_id
   AND slots.is_active;

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

  UPDATE public.cleaning_subscriptions
  SET recurring_day_of_week = p_day_of_week,
      recurring_time = p_start_time,
      subscription_status = 'active',
      is_active = true,
      start_date = v_first_cleaning,
      service_start_date = v_first_cleaning,
      service_end_date = v_service_end,
      end_date = v_service_end,
      paid_until = v_service_end,
      cleanings_remaining = GREATEST(v_purchased_cleanings - v_created_count, 0),
      updated_at = now()
  WHERE id = p_subscription_id;

  RETURN jsonb_build_object(
    'subscription_id', p_subscription_id,
    'bookings_created', v_created_count,
    'service_start_date', v_first_cleaning,
    'service_end_date', v_service_end,
    'recurring_day_of_week', p_day_of_week,
    'recurring_time', p_start_time
  );
END;
$function$;

drop function if exists public._probe_cmp();

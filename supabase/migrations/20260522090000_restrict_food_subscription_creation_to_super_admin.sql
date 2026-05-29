-- Food is in preview. Only super admins may create meal subscriptions until
-- the public Food experience is ready.

DROP POLICY IF EXISTS "Users can create their own subscriptions" ON public.subscriptions;

CREATE POLICY "Only super admins can create meal subscriptions"
ON public.subscriptions
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE OR REPLACE FUNCTION public.create_subscription_by_pubkey(
  p_pubkey text,
  p_restaurant_id uuid,
  p_plan_id uuid,
  p_start_date date,
  p_end_date date,
  p_duration_weeks integer,
  p_total_price_sats integer,
  p_payment_reference text
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  restaurant_id uuid,
  plan_id uuid,
  start_date date,
  end_date date,
  duration_weeks integer,
  total_price_sats integer,
  payment_reference text,
  payment_status payment_status,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_subscription_id UUID;
BEGIN
  PERFORM set_config('app.current_pubkey', p_pubkey, true);

  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF NOT public.has_role(v_user_id, 'super_admin') THEN
    RAISE EXCEPTION 'Food subscriptions are only available to super admins';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.subscription_plans sp
    WHERE sp.id = p_plan_id
      AND sp.restaurant_id = p_restaurant_id
      AND sp.is_active = true
  ) THEN
    RAISE EXCEPTION 'Plan not found or not active';
  END IF;

  INSERT INTO public.subscriptions (
    user_id, restaurant_id, plan_id, start_date, end_date,
    duration_weeks, total_price_sats,
    payment_method, payment_reference, payment_status, is_active
  )
  VALUES (
    v_user_id, p_restaurant_id, p_plan_id, p_start_date, p_end_date,
    p_duration_weeks, p_total_price_sats,
    'lightning', p_payment_reference, 'paid', true
  )
  RETURNING subscriptions.id INTO v_subscription_id;

  PERFORM public.generate_meal_choices_for_subscription(v_subscription_id);

  RETURN QUERY
  SELECT
    s.id, s.user_id, s.restaurant_id, s.plan_id, s.start_date, s.end_date,
    s.duration_weeks, s.total_price_sats,
    s.payment_reference, s.payment_status, s.is_active
  FROM public.subscriptions s
  WHERE s.id = v_subscription_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_subscription_by_pubkey(
  p_pubkey text,
  p_restaurant_id uuid,
  p_plan_id uuid,
  p_start_date date,
  p_end_date date,
  p_duration_weeks integer,
  p_total_price_sats integer,
  p_payment_reference text,
  p_payment_status text DEFAULT 'pending'::text
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  restaurant_id uuid,
  plan_id uuid,
  start_date date,
  end_date date,
  duration_weeks integer,
  total_price_sats integer,
  payment_reference text,
  payment_status payment_status,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_subscription_id UUID;
  v_payment_status payment_status;
BEGIN
  IF p_payment_status NOT IN ('pending', 'paid') THEN
    RAISE EXCEPTION 'Invalid payment_status. Must be pending or paid';
  END IF;

  v_payment_status := p_payment_status::payment_status;

  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    SELECT u.id INTO v_user_id
    FROM public.users u
    WHERE u.lightning_pubkey = p_pubkey;

    IF v_user_id IS NOT NULL THEN
      PERFORM set_config('app.current_pubkey', p_pubkey, true);
    END IF;
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.has_role(v_user_id, 'super_admin') THEN
    RAISE EXCEPTION 'Food subscriptions are only available to super admins';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.subscription_plans sp
    WHERE sp.id = p_plan_id
      AND sp.restaurant_id = p_restaurant_id
      AND sp.is_active = true
  ) THEN
    RAISE EXCEPTION 'Plan not found or not active';
  END IF;

  INSERT INTO public.subscriptions (
    user_id, restaurant_id, plan_id, start_date, end_date,
    duration_weeks, total_price_sats,
    payment_method, payment_reference, payment_status, is_active
  )
  VALUES (
    v_user_id, p_restaurant_id, p_plan_id, p_start_date, p_end_date,
    p_duration_weeks, p_total_price_sats,
    'lightning', p_payment_reference, v_payment_status, true
  )
  RETURNING subscriptions.id INTO v_subscription_id;

  PERFORM public.generate_meal_choices_for_subscription(v_subscription_id);

  RETURN QUERY
  SELECT
    s.id, s.user_id, s.restaurant_id, s.plan_id, s.start_date, s.end_date,
    s.duration_weeks, s.total_price_sats,
    s.payment_reference, s.payment_status, s.is_active
  FROM public.subscriptions s
  WHERE s.id = v_subscription_id;
END;
$function$;

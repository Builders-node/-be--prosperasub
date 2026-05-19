-- Update create_subscription_by_pubkey to support hybrid auth (OAuth + Lightning)
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
  v_plan_price INTEGER;
  v_calculated_total INTEGER;
  v_payment_status payment_status;
BEGIN
  -- Validate payment_status parameter
  IF p_payment_status NOT IN ('pending', 'paid') THEN
    RAISE EXCEPTION 'Invalid payment_status. Must be pending or paid';
  END IF;
  
  -- Cast to enum
  v_payment_status := p_payment_status::payment_status;
  
  -- HYBRID AUTH: First try to get user from Supabase Auth (OAuth/email)
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey lookup
    SELECT u.id INTO v_user_id
    FROM public.users u
    WHERE u.lightning_pubkey = p_pubkey;
    
    -- Also set session for Lightning users
    IF v_user_id IS NOT NULL THEN
      PERFORM set_config('app.current_pubkey', p_pubkey, true);
    END IF;
  END IF;
  
  -- Verify user is authenticated
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- SECURITY: Validate plan exists and get actual price
  SELECT sp.price_per_week_sats INTO v_plan_price
  FROM public.subscription_plans sp
  WHERE sp.id = p_plan_id
    AND sp.restaurant_id = p_restaurant_id
    AND sp.is_active = true;
  
  IF v_plan_price IS NULL THEN
    RAISE EXCEPTION 'Plan not found or not active';
  END IF;
  
  -- SECURITY: Validate total matches plan price * weeks
  v_calculated_total := v_plan_price * p_duration_weeks;
  IF v_calculated_total != p_total_price_sats THEN
    RAISE EXCEPTION 'Price mismatch';
  END IF;
  
  -- Create subscription (is_active = true for both paid and pending to allow meal choices)
  INSERT INTO public.subscriptions (
    user_id, restaurant_id, plan_id, start_date, end_date,
    duration_weeks, total_price_sats,
    payment_method, payment_reference, payment_status, is_active
  )
  VALUES (
    v_user_id, p_restaurant_id, p_plan_id, p_start_date, p_end_date,
    p_duration_weeks, v_calculated_total,
    'lightning', p_payment_reference, v_payment_status, true
  )
  RETURNING subscriptions.id INTO v_subscription_id;
  
  -- Generate meal choices for the subscription
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
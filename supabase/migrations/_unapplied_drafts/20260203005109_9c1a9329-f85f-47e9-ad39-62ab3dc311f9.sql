-- Update get_subscription_detail_by_pubkey to support hybrid auth (OAuth + Lightning)
CREATE OR REPLACE FUNCTION public.get_subscription_detail_by_pubkey(p_pubkey text, p_subscription_id uuid)
RETURNS TABLE(
  id uuid, 
  user_id uuid, 
  restaurant_id uuid, 
  plan_id uuid, 
  start_date date, 
  end_date date, 
  duration_weeks integer, 
  total_price_sats integer, 
  payment_status payment_status, 
  payment_method payment_method, 
  is_active boolean, 
  created_at timestamp with time zone, 
  updated_at timestamp with time zone, 
  payment_reference text, 
  restaurant_name text, 
  restaurant_logo_url text, 
  restaurant_address text, 
  plan_name text, 
  plan_meal_time time without time zone, 
  plan_supports_delivery boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  -- HYBRID AUTH: First try Supabase Auth (OAuth/email)
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey lookup
    SELECT u.id INTO v_user_id
    FROM public.users u
    WHERE u.lightning_pubkey = p_pubkey;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.user_id,
    s.restaurant_id,
    s.plan_id,
    s.start_date,
    s.end_date,
    s.duration_weeks,
    s.total_price_sats,
    s.payment_status,
    s.payment_method,
    s.is_active,
    s.created_at,
    s.updated_at,
    s.payment_reference,
    r.name AS restaurant_name,
    r.logo_url AS restaurant_logo_url,
    r.address AS restaurant_address,
    sp.name AS plan_name,
    sp.meal_time AS plan_meal_time,
    sp.supports_delivery AS plan_supports_delivery
  FROM public.subscriptions s
  JOIN public.restaurants r ON r.id = s.restaurant_id
  JOIN public.subscription_plans sp ON sp.id = s.plan_id
  WHERE s.id = p_subscription_id
    AND s.user_id = v_user_id
  LIMIT 1;
END;
$function$;

-- Update get_daily_meal_choices_by_pubkey to support hybrid auth
CREATE OR REPLACE FUNCTION public.get_daily_meal_choices_by_pubkey(p_pubkey text, p_subscription_id uuid)
RETURNS SETOF daily_meal_choices
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  -- HYBRID AUTH: First try Supabase Auth (OAuth/email)
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey lookup
    SELECT u.id INTO v_user_id
    FROM public.users u
    WHERE u.lightning_pubkey = p_pubkey;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Ensure subscription belongs to this user
  IF NOT EXISTS (
    SELECT 1
    FROM public.subscriptions s
    WHERE s.id = p_subscription_id
      AND s.user_id = v_user_id
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT dmc.*
  FROM public.daily_meal_choices dmc
  WHERE dmc.subscription_id = p_subscription_id
  ORDER BY dmc.date ASC;
END;
$function$;
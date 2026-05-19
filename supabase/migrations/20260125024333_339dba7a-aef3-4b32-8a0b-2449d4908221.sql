
-- Update the create_subscription_plan_by_pubkey function to also check for super_admin role
CREATE OR REPLACE FUNCTION public.create_subscription_plan_by_pubkey(
  p_pubkey text, 
  p_name text, 
  p_price_per_week_sats integer, 
  p_description text DEFAULT NULL::text, 
  p_meal_time time without time zone DEFAULT '13:00:00'::time without time zone, 
  p_max_duration_weeks integer DEFAULT 4, 
  p_supports_delivery boolean DEFAULT true, 
  p_is_active boolean DEFAULT true, 
  p_menu_category menu_category DEFAULT 'standard'::menu_category, 
  p_restaurant_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, restaurant_id uuid, name text, description text, price_per_week_sats integer, meal_time time without time zone, max_duration_weeks integer, supports_delivery boolean, is_active boolean, menu_category menu_category)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_restaurant_id UUID;
  v_is_super_admin BOOLEAN := FALSE;
BEGIN
  -- First try to get user from Supabase Auth
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey
    SELECT u.id INTO v_user_id FROM users u WHERE u.lightning_pubkey = p_pubkey;
  END IF;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Check if user is super_admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = v_user_id AND role = 'super_admin'
  ) INTO v_is_super_admin;
  
  -- Determine restaurant_id
  IF p_restaurant_id IS NOT NULL THEN
    -- Use provided restaurant_id
    v_restaurant_id := p_restaurant_id;
  ELSE
    -- Fallback to legacy users.restaurant_id for backwards compatibility
    SELECT u.restaurant_id INTO v_restaurant_id FROM users u WHERE u.id = v_user_id;
  END IF;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant specified';
  END IF;
  
  -- Verify user has access: super_admin OR restaurant_admins OR legacy users.restaurant_id
  IF NOT v_is_super_admin AND NOT EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.user_id = v_user_id AND ra.restaurant_id = v_restaurant_id
  ) AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = v_user_id AND u.restaurant_id = v_restaurant_id
  ) THEN
    RAISE EXCEPTION 'User does not have access to this restaurant';
  END IF;
  
  RETURN QUERY
  INSERT INTO subscription_plans (
    restaurant_id, name, description, price_per_week_sats,
    meal_time, max_duration_weeks, supports_delivery, is_active, menu_category
  )
  VALUES (
    v_restaurant_id, p_name, p_description, p_price_per_week_sats,
    p_meal_time, p_max_duration_weeks, p_supports_delivery, p_is_active, p_menu_category
  )
  RETURNING 
    subscription_plans.id,
    subscription_plans.restaurant_id,
    subscription_plans.name,
    subscription_plans.description,
    subscription_plans.price_per_week_sats,
    subscription_plans.meal_time,
    subscription_plans.max_duration_weeks,
    subscription_plans.supports_delivery,
    subscription_plans.is_active,
    subscription_plans.menu_category;
END;
$function$;

-- Also update update and delete functions for consistency
CREATE OR REPLACE FUNCTION public.update_subscription_plan_by_pubkey(
  p_pubkey text, 
  p_plan_id uuid, 
  p_name text, 
  p_price_per_week_sats integer, 
  p_description text DEFAULT NULL::text, 
  p_meal_time time without time zone DEFAULT '13:00:00'::time without time zone, 
  p_max_duration_weeks integer DEFAULT 4, 
  p_supports_delivery boolean DEFAULT true, 
  p_is_active boolean DEFAULT true, 
  p_menu_category menu_category DEFAULT 'standard'::menu_category
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_restaurant_id UUID;
  v_is_super_admin BOOLEAN := FALSE;
BEGIN
  -- First try to get user from Supabase Auth
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey
    SELECT u.id INTO v_user_id FROM users u WHERE u.lightning_pubkey = p_pubkey;
  END IF;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Check if user is super_admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = v_user_id AND role = 'super_admin'
  ) INTO v_is_super_admin;
  
  -- Get the restaurant_id from the plan
  SELECT sp.restaurant_id INTO v_restaurant_id
  FROM subscription_plans sp
  WHERE sp.id = p_plan_id;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;
  
  -- Verify user has access: super_admin OR restaurant_admins OR legacy users.restaurant_id
  IF NOT v_is_super_admin AND NOT EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.user_id = v_user_id AND ra.restaurant_id = v_restaurant_id
  ) AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = v_user_id AND u.restaurant_id = v_restaurant_id
  ) THEN
    RAISE EXCEPTION 'User does not have access to this restaurant';
  END IF;
  
  UPDATE subscription_plans
  SET 
    name = p_name,
    description = p_description,
    price_per_week_sats = p_price_per_week_sats,
    meal_time = p_meal_time,
    max_duration_weeks = p_max_duration_weeks,
    supports_delivery = p_supports_delivery,
    is_active = p_is_active,
    menu_category = p_menu_category,
    updated_at = now()
  WHERE id = p_plan_id;
  
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_subscription_plan_by_pubkey(
  p_pubkey text, 
  p_plan_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_restaurant_id UUID;
  v_is_super_admin BOOLEAN := FALSE;
BEGIN
  -- First try to get user from Supabase Auth
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey
    SELECT u.id INTO v_user_id FROM users u WHERE u.lightning_pubkey = p_pubkey;
  END IF;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Check if user is super_admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = v_user_id AND role = 'super_admin'
  ) INTO v_is_super_admin;
  
  -- Get the restaurant_id from the plan
  SELECT sp.restaurant_id INTO v_restaurant_id
  FROM subscription_plans sp
  WHERE sp.id = p_plan_id;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;
  
  -- Verify user has access: super_admin OR restaurant_admins OR legacy users.restaurant_id
  IF NOT v_is_super_admin AND NOT EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.user_id = v_user_id AND ra.restaurant_id = v_restaurant_id
  ) AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = v_user_id AND u.restaurant_id = v_restaurant_id
  ) THEN
    RAISE EXCEPTION 'User does not have access to this restaurant';
  END IF;
  
  DELETE FROM subscription_plans WHERE id = p_plan_id;
  
  RETURN FOUND;
END;
$function$;

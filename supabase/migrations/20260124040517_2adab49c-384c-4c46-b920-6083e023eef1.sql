-- Update create_subscription_plan_by_pubkey to support multi-restaurant architecture
-- Now accepts p_restaurant_id and verifies ownership via restaurant_admins table

CREATE OR REPLACE FUNCTION public.create_subscription_plan_by_pubkey(
  p_pubkey TEXT,
  p_name TEXT,
  p_price_per_week_sats INTEGER,
  p_description TEXT DEFAULT NULL,
  p_meal_time TIME DEFAULT '13:00:00',
  p_max_duration_weeks INTEGER DEFAULT 4,
  p_supports_delivery BOOLEAN DEFAULT true,
  p_is_active BOOLEAN DEFAULT true,
  p_menu_category menu_category DEFAULT 'standard',
  p_restaurant_id UUID DEFAULT NULL
)
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  name TEXT,
  description TEXT,
  price_per_week_sats INTEGER,
  meal_time TIME,
  max_duration_weeks INTEGER,
  supports_delivery BOOLEAN,
  is_active BOOLEAN,
  menu_category menu_category
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_restaurant_id UUID;
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
  
  -- Determine restaurant_id
  IF p_restaurant_id IS NOT NULL THEN
    -- Use provided restaurant_id, but verify access
    v_restaurant_id := p_restaurant_id;
  ELSE
    -- Fallback to legacy users.restaurant_id for backwards compatibility
    SELECT u.restaurant_id INTO v_restaurant_id FROM users u WHERE u.id = v_user_id;
  END IF;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant specified';
  END IF;
  
  -- Verify user has access to this restaurant via restaurant_admins OR legacy users.restaurant_id
  IF NOT EXISTS (
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
$$;
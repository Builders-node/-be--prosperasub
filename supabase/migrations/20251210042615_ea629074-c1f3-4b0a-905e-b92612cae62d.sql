-- Create subscription plan for Solana users
CREATE OR REPLACE FUNCTION public.create_subscription_plan_for_solana(
  p_wallet_address TEXT,
  p_name TEXT,
  p_price_per_week_sats INTEGER,
  p_price_per_week_sol NUMERIC,
  p_description TEXT DEFAULT NULL,
  p_meal_time TIME DEFAULT '13:00',
  p_max_duration_weeks INTEGER DEFAULT 4,
  p_supports_delivery BOOLEAN DEFAULT true,
  p_is_active BOOLEAN DEFAULT true,
  p_menu_category menu_category DEFAULT 'standard'
)
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  name TEXT,
  description TEXT,
  price_per_week_sats INTEGER,
  price_per_week_sol NUMERIC,
  meal_time TIME,
  max_duration_weeks INTEGER,
  supports_delivery BOOLEAN,
  is_active BOOLEAN,
  menu_category menu_category
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  RETURN QUERY
  INSERT INTO public.subscription_plans (
    restaurant_id, name, description, price_per_week_sats, price_per_week_sol,
    meal_time, max_duration_weeks, supports_delivery, is_active, menu_category
  )
  VALUES (
    v_restaurant_id, p_name, p_description, p_price_per_week_sats, p_price_per_week_sol,
    p_meal_time, p_max_duration_weeks, p_supports_delivery, p_is_active, p_menu_category
  )
  RETURNING 
    subscription_plans.id,
    subscription_plans.restaurant_id,
    subscription_plans.name,
    subscription_plans.description,
    subscription_plans.price_per_week_sats,
    subscription_plans.price_per_week_sol,
    subscription_plans.meal_time,
    subscription_plans.max_duration_weeks,
    subscription_plans.supports_delivery,
    subscription_plans.is_active,
    subscription_plans.menu_category;
END;
$$;

-- Update subscription plan for Solana users
CREATE OR REPLACE FUNCTION public.update_subscription_plan_for_solana(
  p_wallet_address TEXT,
  p_plan_id UUID,
  p_name TEXT,
  p_price_per_week_sats INTEGER,
  p_price_per_week_sol NUMERIC,
  p_description TEXT DEFAULT NULL,
  p_meal_time TIME DEFAULT '13:00',
  p_max_duration_weeks INTEGER DEFAULT 4,
  p_supports_delivery BOOLEAN DEFAULT true,
  p_is_active BOOLEAN DEFAULT true,
  p_menu_category menu_category DEFAULT 'standard'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  UPDATE public.subscription_plans
  SET 
    name = p_name,
    description = p_description,
    price_per_week_sats = p_price_per_week_sats,
    price_per_week_sol = p_price_per_week_sol,
    meal_time = p_meal_time,
    max_duration_weeks = p_max_duration_weeks,
    supports_delivery = p_supports_delivery,
    is_active = p_is_active,
    menu_category = p_menu_category,
    updated_at = now()
  WHERE id = p_plan_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Delete subscription plan for Solana users
CREATE OR REPLACE FUNCTION public.delete_subscription_plan_for_solana(
  p_wallet_address TEXT,
  p_plan_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  DELETE FROM public.subscription_plans
  WHERE id = p_plan_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Get subscription plans for Solana users
CREATE OR REPLACE FUNCTION public.get_subscription_plans_for_solana(
  p_wallet_address TEXT
)
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  name TEXT,
  description TEXT,
  price_per_week_sats INTEGER,
  price_per_week_sol NUMERIC,
  meal_time TIME,
  max_duration_weeks INTEGER,
  supports_delivery BOOLEAN,
  is_active BOOLEAN,
  menu_category menu_category,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    sp.id,
    sp.restaurant_id,
    sp.name,
    sp.description,
    sp.price_per_week_sats,
    sp.price_per_week_sol,
    sp.meal_time,
    sp.max_duration_weeks,
    sp.supports_delivery,
    sp.is_active,
    sp.menu_category,
    sp.created_at,
    sp.updated_at
  FROM public.subscription_plans sp
  WHERE sp.restaurant_id = v_restaurant_id;
END;
$$;
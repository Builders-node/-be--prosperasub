-- Create RPC function to fetch subscription plans with proper auth handling
CREATE OR REPLACE FUNCTION public.get_subscription_plans_by_restaurant(
  p_pubkey text,
  p_restaurant_id uuid
)
RETURNS SETOF subscription_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_is_super_admin BOOLEAN := FALSE;
BEGIN
  -- First try to get user from Supabase Auth (Google OAuth)
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey
    SELECT id INTO v_user_id FROM users WHERE lightning_pubkey = p_pubkey;
  END IF;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Check if user is super_admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = v_user_id AND role = 'super_admin'
  ) INTO v_is_super_admin;
  
  -- Verify user has access: super_admin OR restaurant_admins OR legacy users.restaurant_id
  IF NOT v_is_super_admin AND NOT EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.user_id = v_user_id AND ra.restaurant_id = p_restaurant_id
  ) AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = v_user_id AND u.restaurant_id = p_restaurant_id
  ) THEN
    RAISE EXCEPTION 'No access to this restaurant';
  END IF;
  
  -- Return plans for the restaurant
  RETURN QUERY
  SELECT * FROM subscription_plans sp
  WHERE sp.restaurant_id = p_restaurant_id
  ORDER BY sp.created_at DESC;
END;
$$;
-- Drop and recreate the function to support both Lightning and Supabase Auth
DROP FUNCTION IF EXISTS public.create_weekly_menu_by_pubkey(text, uuid, date, date, menu_category);

CREATE OR REPLACE FUNCTION public.create_weekly_menu_by_pubkey(
  p_pubkey TEXT,
  p_restaurant_id UUID,
  p_week_start_date DATE,
  p_week_end_date DATE,
  p_category menu_category DEFAULT 'standard'
)
RETURNS SETOF weekly_menus
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- First try to get user from Supabase Auth
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey
    SELECT id INTO v_user_id FROM users WHERE lightning_pubkey = p_pubkey;
  END IF;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Verify user has access to this restaurant
  IF NOT EXISTS (
    SELECT 1 FROM restaurant_admins 
    WHERE user_id = v_user_id AND restaurant_id = p_restaurant_id
  ) AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = v_user_id AND restaurant_id = p_restaurant_id
  ) THEN
    RAISE EXCEPTION 'User does not have access to this restaurant';
  END IF;
  
  -- Insert and return the new menu
  RETURN QUERY
  INSERT INTO weekly_menus (restaurant_id, week_start_date, week_end_date, category, status)
  VALUES (p_restaurant_id, p_week_start_date, p_week_end_date, p_category, 'draft')
  RETURNING *;
END;
$$;
-- Create security definer function for creating weekly menus by pubkey
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
  -- Get the user ID from the pubkey
  SELECT id INTO v_user_id FROM users WHERE lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for pubkey';
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
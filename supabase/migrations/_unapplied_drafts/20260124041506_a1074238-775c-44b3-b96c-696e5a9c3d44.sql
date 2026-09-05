-- Create a function to get weekly menus by pubkey that works with restaurant_admins
CREATE OR REPLACE FUNCTION public.get_weekly_menus_by_restaurant(
  p_pubkey TEXT,
  p_restaurant_id UUID,
  p_week_start TEXT,
  p_week_end TEXT
)
RETURNS TABLE (
  id UUID,
  restaurant_id UUID,
  plan_id UUID,
  week_start_date DATE,
  week_end_date DATE,
  status menu_status,
  category menu_category,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  menu_items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_has_access BOOLEAN := FALSE;
BEGIN
  -- Try to get user_id from auth.uid() first (for Google/email auth)
  v_user_id := auth.uid();
  
  -- If no auth.uid(), try to get from lightning pubkey
  IF v_user_id IS NULL AND p_pubkey IS NOT NULL AND p_pubkey != '' THEN
    SELECT u.id INTO v_user_id
    FROM users u
    WHERE u.lightning_pubkey = p_pubkey;
  END IF;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Check if user has access to this restaurant via restaurant_admins or users.restaurant_id
  SELECT EXISTS (
    SELECT 1 FROM restaurant_admins ra 
    WHERE ra.user_id = v_user_id AND ra.restaurant_id = p_restaurant_id
    UNION
    SELECT 1 FROM users u 
    WHERE u.id = v_user_id AND u.restaurant_id = p_restaurant_id
  ) INTO v_has_access;
  
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'No access to this restaurant';
  END IF;
  
  -- Return menus with their items as JSONB
  RETURN QUERY
  SELECT 
    wm.id,
    wm.restaurant_id,
    wm.plan_id,
    wm.week_start_date,
    wm.week_end_date,
    wm.status,
    wm.category,
    wm.created_at,
    wm.updated_at,
    COALESCE(
      (SELECT jsonb_agg(row_to_json(mi.*))
       FROM menu_items mi 
       WHERE mi.weekly_menu_id = wm.id),
      '[]'::jsonb
    ) as menu_items
  FROM weekly_menus wm
  WHERE wm.restaurant_id = p_restaurant_id
    AND wm.week_start_date >= p_week_start::date
    AND wm.week_end_date <= p_week_end::date;
END;
$$;
-- Update the update_menu_status_by_pubkey function to support OAuth users
CREATE OR REPLACE FUNCTION public.update_menu_status_by_pubkey(p_pubkey text, p_menu_id uuid, p_status menu_status)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_restaurant_id UUID;
  v_has_access BOOLEAN := FALSE;
BEGIN
  -- First try to get user from Supabase Auth (Google OAuth)
  IF auth.uid() IS NOT NULL THEN
    v_user_id := auth.uid();
  ELSE
    -- Fallback to Lightning pubkey
    SELECT u.id INTO v_user_id FROM users u WHERE u.lightning_pubkey = p_pubkey;
  END IF;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Get the restaurant_id from the menu
  SELECT wm.restaurant_id INTO v_restaurant_id
  FROM weekly_menus wm
  WHERE wm.id = p_menu_id;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Menu not found';
  END IF;
  
  -- Check if user has access to this restaurant via restaurant_admins or users.restaurant_id
  SELECT EXISTS (
    SELECT 1 FROM restaurant_admins ra 
    WHERE ra.user_id = v_user_id AND ra.restaurant_id = v_restaurant_id
    UNION
    SELECT 1 FROM users u 
    WHERE u.id = v_user_id AND u.restaurant_id = v_restaurant_id
  ) INTO v_has_access;
  
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'No access to this restaurant';
  END IF;
  
  UPDATE weekly_menus
  SET status = p_status, updated_at = now()
  WHERE id = p_menu_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$function$;
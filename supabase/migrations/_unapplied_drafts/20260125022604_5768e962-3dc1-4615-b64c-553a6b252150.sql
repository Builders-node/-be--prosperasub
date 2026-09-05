-- Update create_menu_item_by_pubkey with hybrid auth and restaurant_id parameter
CREATE OR REPLACE FUNCTION public.create_menu_item_by_pubkey(
  p_pubkey text, 
  p_weekly_menu_id uuid, 
  p_restaurant_id uuid,
  p_day_of_week day_of_week, 
  p_meal_type meal_type_slot, 
  p_name text, 
  p_description text DEFAULT NULL::text, 
  p_tags text[] DEFAULT '{}'::text[], 
  p_image_url text DEFAULT NULL::text
)
RETURNS TABLE(id uuid, weekly_menu_id uuid, restaurant_id uuid, day_of_week day_of_week, meal_type meal_type_slot, name text, description text, tags text[], image_url text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
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
  
  -- Verify menu belongs to the restaurant
  IF NOT EXISTS (SELECT 1 FROM weekly_menus wm WHERE wm.id = p_weekly_menu_id AND wm.restaurant_id = p_restaurant_id) THEN
    RAISE EXCEPTION 'Menu does not belong to your restaurant';
  END IF;
  
  -- Delete existing item for this slot (upsert behavior)
  DELETE FROM menu_items mi
  WHERE mi.weekly_menu_id = p_weekly_menu_id 
    AND mi.day_of_week = p_day_of_week 
    AND mi.meal_type = p_meal_type
    AND mi.restaurant_id = p_restaurant_id;
  
  RETURN QUERY
  INSERT INTO menu_items (weekly_menu_id, restaurant_id, day_of_week, meal_type, name, description, tags, image_url)
  VALUES (p_weekly_menu_id, p_restaurant_id, p_day_of_week, p_meal_type, p_name, p_description, p_tags, p_image_url)
  RETURNING 
    menu_items.id, 
    menu_items.weekly_menu_id, 
    menu_items.restaurant_id, 
    menu_items.day_of_week, 
    menu_items.meal_type, 
    menu_items.name, 
    menu_items.description, 
    menu_items.tags, 
    menu_items.image_url;
END;
$function$;

-- Update update_menu_item_by_pubkey with hybrid auth
CREATE OR REPLACE FUNCTION public.update_menu_item_by_pubkey(
  p_pubkey text, 
  p_item_id uuid, 
  p_name text, 
  p_description text DEFAULT NULL::text, 
  p_tags text[] DEFAULT '{}'::text[], 
  p_image_url text DEFAULT NULL::text
)
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
  
  -- Get the restaurant_id from the menu item
  SELECT mi.restaurant_id INTO v_restaurant_id
  FROM menu_items mi
  WHERE mi.id = p_item_id;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Menu item not found';
  END IF;
  
  -- Check if user has access to this restaurant
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
  
  UPDATE menu_items
  SET name = p_name, description = p_description, tags = p_tags, image_url = p_image_url, updated_at = now()
  WHERE id = p_item_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$function$;

-- Update delete_menu_item_by_pubkey with hybrid auth
CREATE OR REPLACE FUNCTION public.delete_menu_item_by_pubkey(
  p_pubkey text, 
  p_item_id uuid
)
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
  
  -- Get the restaurant_id from the menu item
  SELECT mi.restaurant_id INTO v_restaurant_id
  FROM menu_items mi
  WHERE mi.id = p_item_id;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Menu item not found';
  END IF;
  
  -- Check if user has access to this restaurant
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
  
  DELETE FROM menu_items
  WHERE id = p_item_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$function$;
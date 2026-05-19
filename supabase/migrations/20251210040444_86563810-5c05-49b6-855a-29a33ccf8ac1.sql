-- Drop and recreate the function with proper column disambiguation
DROP FUNCTION IF EXISTS public.create_menu_item_for_solana(text, uuid, day_of_week, meal_type_slot, text, text, text[], text);

CREATE OR REPLACE FUNCTION public.create_menu_item_for_solana(
  p_wallet_address text,
  p_weekly_menu_id uuid,
  p_day_of_week day_of_week,
  p_meal_type meal_type_slot,
  p_name text,
  p_description text DEFAULT NULL,
  p_tags text[] DEFAULT '{}',
  p_image_url text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  weekly_menu_id uuid,
  restaurant_id uuid,
  day_of_week day_of_week,
  meal_type meal_type_slot,
  name text,
  description text,
  tags text[],
  image_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  -- Verify the menu belongs to the user's restaurant
  IF NOT EXISTS (SELECT 1 FROM public.weekly_menus wm WHERE wm.id = p_weekly_menu_id AND wm.restaurant_id = v_restaurant_id) THEN
    RAISE EXCEPTION 'Menu does not belong to your restaurant';
  END IF;
  
  -- Delete existing item for this day/meal_type if exists (replace mode)
  DELETE FROM public.menu_items mi
  WHERE mi.weekly_menu_id = p_weekly_menu_id 
    AND mi.day_of_week = p_day_of_week 
    AND mi.meal_type = p_meal_type
    AND mi.restaurant_id = v_restaurant_id;
  
  RETURN QUERY
  INSERT INTO public.menu_items (weekly_menu_id, restaurant_id, day_of_week, meal_type, name, description, tags, image_url)
  VALUES (p_weekly_menu_id, v_restaurant_id, p_day_of_week, p_meal_type, p_name, p_description, p_tags, p_image_url)
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
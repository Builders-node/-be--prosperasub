-- Create weekly menu for Solana user
CREATE OR REPLACE FUNCTION public.create_weekly_menu_for_solana(
  p_wallet_address text,
  p_week_start_date date,
  p_week_end_date date
)
RETURNS TABLE(id uuid, restaurant_id uuid, week_start_date date, week_end_date date, status menu_status)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  INSERT INTO public.weekly_menus (restaurant_id, week_start_date, week_end_date, status)
  VALUES (v_restaurant_id, p_week_start_date, p_week_end_date, 'draft')
  RETURNING weekly_menus.id, weekly_menus.restaurant_id, weekly_menus.week_start_date, weekly_menus.week_end_date, weekly_menus.status;
END;
$$;

-- Create menu item for Solana user
CREATE OR REPLACE FUNCTION public.create_menu_item_for_solana(
  p_wallet_address text,
  p_weekly_menu_id uuid,
  p_day_of_week day_of_week,
  p_name text,
  p_description text DEFAULT NULL,
  p_tags text[] DEFAULT '{}',
  p_image_url text DEFAULT NULL
)
RETURNS TABLE(id uuid, weekly_menu_id uuid, restaurant_id uuid, day_of_week day_of_week, name text, description text, tags text[], image_url text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  
  RETURN QUERY
  INSERT INTO public.menu_items (weekly_menu_id, restaurant_id, day_of_week, name, description, tags, image_url)
  VALUES (p_weekly_menu_id, v_restaurant_id, p_day_of_week, p_name, p_description, p_tags, p_image_url)
  RETURNING menu_items.id, menu_items.weekly_menu_id, menu_items.restaurant_id, menu_items.day_of_week, menu_items.name, menu_items.description, menu_items.tags, menu_items.image_url;
END;
$$;

-- Update menu item for Solana user
CREATE OR REPLACE FUNCTION public.update_menu_item_for_solana(
  p_wallet_address text,
  p_item_id uuid,
  p_name text,
  p_description text DEFAULT NULL,
  p_tags text[] DEFAULT '{}',
  p_image_url text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  -- Update only if item belongs to user's restaurant
  UPDATE public.menu_items
  SET name = p_name, description = p_description, tags = p_tags, image_url = p_image_url, updated_at = now()
  WHERE id = p_item_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Delete menu item for Solana user
CREATE OR REPLACE FUNCTION public.delete_menu_item_for_solana(
  p_wallet_address text,
  p_item_id uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  DELETE FROM public.menu_items
  WHERE id = p_item_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Update menu status for Solana user
CREATE OR REPLACE FUNCTION public.update_menu_status_for_solana(
  p_wallet_address text,
  p_menu_id uuid,
  p_status menu_status
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  UPDATE public.weekly_menus
  SET status = p_status, updated_at = now()
  WHERE id = p_menu_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Get weekly menus for Solana user's restaurant
CREATE OR REPLACE FUNCTION public.get_weekly_menus_for_solana(
  p_wallet_address text,
  p_week_start date,
  p_week_end date
)
RETURNS TABLE(
  id uuid, 
  restaurant_id uuid, 
  week_start_date date, 
  week_end_date date, 
  status menu_status,
  menu_items jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
    wm.id,
    wm.restaurant_id,
    wm.week_start_date,
    wm.week_end_date,
    wm.status,
    COALESCE(
      (SELECT jsonb_agg(row_to_json(mi.*))
       FROM public.menu_items mi
       WHERE mi.weekly_menu_id = wm.id),
      '[]'::jsonb
    ) as menu_items
  FROM public.weekly_menus wm
  WHERE wm.restaurant_id = v_restaurant_id
    AND wm.week_start_date = p_week_start
    AND wm.week_end_date = p_week_end;
END;
$$;
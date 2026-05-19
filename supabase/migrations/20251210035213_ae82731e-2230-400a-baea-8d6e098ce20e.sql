-- Create menu category enum for different diet types
CREATE TYPE public.menu_category AS ENUM ('standard', 'vegetarian', 'vegan', 'keto', 'gluten_free', 'lactose_free');

-- Add category column to weekly_menus
ALTER TABLE public.weekly_menus 
ADD COLUMN category menu_category NOT NULL DEFAULT 'standard';

-- Add unique constraint so only one menu per category per week per restaurant
ALTER TABLE public.weekly_menus 
ADD CONSTRAINT unique_menu_per_category_per_week 
UNIQUE (restaurant_id, week_start_date, category);

-- Add category to subscription_plans
ALTER TABLE public.subscription_plans 
ADD COLUMN menu_category menu_category DEFAULT 'standard';

-- Drop and recreate get_weekly_menus_for_solana with new return type
DROP FUNCTION IF EXISTS public.get_weekly_menus_for_solana(text, date, date);

CREATE FUNCTION public.get_weekly_menus_for_solana(
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
  category menu_category,
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
    wm.category,
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

-- Update create_weekly_menu_for_solana to include category
DROP FUNCTION IF EXISTS public.create_weekly_menu_for_solana(text, date, date);

CREATE FUNCTION public.create_weekly_menu_for_solana(
  p_wallet_address text,
  p_week_start_date date,
  p_week_end_date date,
  p_category menu_category DEFAULT 'standard'
)
RETURNS TABLE(id uuid, restaurant_id uuid, week_start_date date, week_end_date date, status menu_status, category menu_category)
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
  INSERT INTO public.weekly_menus (restaurant_id, week_start_date, week_end_date, status, category)
  VALUES (v_restaurant_id, p_week_start_date, p_week_end_date, 'draft', p_category)
  RETURNING weekly_menus.id, weekly_menus.restaurant_id, weekly_menus.week_start_date, weekly_menus.week_end_date, weekly_menus.status, weekly_menus.category;
END;
$$;

-- ============================================
-- PHASE 2: Remove Solana + Fix DB Inconsistencies
-- ============================================

-- 1. Add 'driver' role to app_role enum
ALTER TYPE app_role ADD VALUE IF NOT EXISTS 'driver';

-- 2. Remove Solana columns from tables
ALTER TABLE restaurant_wallets DROP COLUMN IF EXISTS solana_wallet_address;
ALTER TABLE subscription_plans DROP COLUMN IF EXISTS price_per_week_sol;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS total_price_sol;

-- 3. Rename restaurant_wallets to restaurant_settings
ALTER TABLE restaurant_wallets RENAME TO restaurant_settings;

-- 4. Update foreign key references and RLS policies for renamed table
-- Drop old policies
DROP POLICY IF EXISTS "Super admins can manage all wallets" ON restaurant_settings;
DROP POLICY IF EXISTS "Restaurant admins can manage their own wallet" ON restaurant_settings;

-- Create new policies with updated names
CREATE POLICY "Super admins can manage all settings"
ON restaurant_settings FOR ALL
USING (has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Restaurant admins can manage their own settings"
ON restaurant_settings FOR ALL
USING (EXISTS (
  SELECT 1 FROM users u
  WHERE u.id = get_current_user_id()
  AND u.restaurant_id = restaurant_settings.restaurant_id
));

-- 5. Create new RPC functions WITHOUT _for_solana suffix
-- These use Lightning pubkey from session config

-- Get restaurant settings (replaces get_restaurant_wallet_for_solana)
CREATE OR REPLACE FUNCTION public.get_restaurant_settings(p_pubkey text)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  lightning_type lightning_wallet_type,
  lightning_identifier text,
  lightning_api_key text,
  test_mode boolean,
  created_at timestamptz,
  updated_at timestamptz
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
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    rs.id,
    rs.restaurant_id,
    rs.lightning_type,
    rs.lightning_identifier,
    rs.lightning_api_key,
    rs.test_mode,
    rs.created_at,
    rs.updated_at
  FROM public.restaurant_settings rs
  WHERE rs.restaurant_id = v_restaurant_id;
END;
$$;

-- Upsert restaurant settings (replaces upsert_restaurant_wallet_for_solana)
CREATE OR REPLACE FUNCTION public.upsert_restaurant_settings(
  p_pubkey text,
  p_lightning_type lightning_wallet_type DEFAULT NULL,
  p_lightning_identifier text DEFAULT NULL,
  p_lightning_api_key text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
  v_existing_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  SELECT id INTO v_existing_id
  FROM public.restaurant_settings
  WHERE restaurant_id = v_restaurant_id;
  
  IF v_existing_id IS NOT NULL THEN
    UPDATE public.restaurant_settings
    SET 
      lightning_type = COALESCE(p_lightning_type, lightning_type),
      lightning_identifier = COALESCE(p_lightning_identifier, lightning_identifier),
      lightning_api_key = COALESCE(p_lightning_api_key, lightning_api_key),
      updated_at = now()
    WHERE id = v_existing_id;
  ELSE
    INSERT INTO public.restaurant_settings (
      restaurant_id, lightning_type, lightning_identifier, lightning_api_key
    )
    VALUES (
      v_restaurant_id, p_lightning_type, p_lightning_identifier, p_lightning_api_key
    );
  END IF;
  
  RETURN true;
END;
$$;

-- Get weekly menus (replaces get_weekly_menus_for_solana)
CREATE OR REPLACE FUNCTION public.get_weekly_menus_by_pubkey(
  p_pubkey text,
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
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

-- Create weekly menu (replaces create_weekly_menu_for_solana)
CREATE OR REPLACE FUNCTION public.create_weekly_menu_by_pubkey(
  p_pubkey text,
  p_week_start_date date,
  p_week_end_date date,
  p_category menu_category DEFAULT 'standard'
)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  week_start_date date,
  week_end_date date,
  status menu_status,
  category menu_category
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
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  RETURN QUERY
  INSERT INTO public.weekly_menus (restaurant_id, week_start_date, week_end_date, status, category)
  VALUES (v_restaurant_id, p_week_start_date, p_week_end_date, 'draft', p_category)
  RETURNING weekly_menus.id, weekly_menus.restaurant_id, weekly_menus.week_start_date, weekly_menus.week_end_date, weekly_menus.status, weekly_menus.category;
END;
$$;

-- Create menu item (replaces create_menu_item_for_solana)
CREATE OR REPLACE FUNCTION public.create_menu_item_by_pubkey(
  p_pubkey text,
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
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM public.weekly_menus wm WHERE wm.id = p_weekly_menu_id AND wm.restaurant_id = v_restaurant_id) THEN
    RAISE EXCEPTION 'Menu does not belong to your restaurant';
  END IF;
  
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
$$;

-- Update menu item (replaces update_menu_item_for_solana)
CREATE OR REPLACE FUNCTION public.update_menu_item_by_pubkey(
  p_pubkey text,
  p_item_id uuid,
  p_name text,
  p_description text DEFAULT NULL,
  p_tags text[] DEFAULT '{}',
  p_image_url text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  UPDATE public.menu_items
  SET name = p_name, description = p_description, tags = p_tags, image_url = p_image_url, updated_at = now()
  WHERE id = p_item_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Delete menu item (replaces delete_menu_item_for_solana)
CREATE OR REPLACE FUNCTION public.delete_menu_item_by_pubkey(
  p_pubkey text,
  p_item_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  DELETE FROM public.menu_items
  WHERE id = p_item_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Update menu status (replaces update_menu_status_for_solana)
CREATE OR REPLACE FUNCTION public.update_menu_status_by_pubkey(
  p_pubkey text,
  p_menu_id uuid,
  p_status menu_status
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  UPDATE public.weekly_menus
  SET status = p_status, updated_at = now()
  WHERE id = p_menu_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Create subscription plan (replaces create_subscription_plan_for_solana)
CREATE OR REPLACE FUNCTION public.create_subscription_plan_by_pubkey(
  p_pubkey text,
  p_name text,
  p_price_per_week_sats integer,
  p_description text DEFAULT NULL,
  p_meal_time time DEFAULT '13:00:00',
  p_max_duration_weeks integer DEFAULT 4,
  p_supports_delivery boolean DEFAULT true,
  p_is_active boolean DEFAULT true,
  p_menu_category menu_category DEFAULT 'standard'
)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  name text,
  description text,
  price_per_week_sats integer,
  meal_time time,
  max_duration_weeks integer,
  supports_delivery boolean,
  is_active boolean,
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
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  RETURN QUERY
  INSERT INTO public.subscription_plans (
    restaurant_id, name, description, price_per_week_sats,
    meal_time, max_duration_weeks, supports_delivery, is_active, menu_category
  )
  VALUES (
    v_restaurant_id, p_name, p_description, p_price_per_week_sats,
    p_meal_time, p_max_duration_weeks, p_supports_delivery, p_is_active, p_menu_category
  )
  RETURNING 
    subscription_plans.id,
    subscription_plans.restaurant_id,
    subscription_plans.name,
    subscription_plans.description,
    subscription_plans.price_per_week_sats,
    subscription_plans.meal_time,
    subscription_plans.max_duration_weeks,
    subscription_plans.supports_delivery,
    subscription_plans.is_active,
    subscription_plans.menu_category;
END;
$$;

-- Update subscription plan (replaces update_subscription_plan_for_solana)
CREATE OR REPLACE FUNCTION public.update_subscription_plan_by_pubkey(
  p_pubkey text,
  p_plan_id uuid,
  p_name text,
  p_price_per_week_sats integer,
  p_description text DEFAULT NULL,
  p_meal_time time DEFAULT '13:00:00',
  p_max_duration_weeks integer DEFAULT 4,
  p_supports_delivery boolean DEFAULT true,
  p_is_active boolean DEFAULT true,
  p_menu_category menu_category DEFAULT 'standard'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  UPDATE public.subscription_plans
  SET 
    name = p_name,
    description = p_description,
    price_per_week_sats = p_price_per_week_sats,
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

-- Delete subscription plan (replaces delete_subscription_plan_for_solana)
CREATE OR REPLACE FUNCTION public.delete_subscription_plan_by_pubkey(
  p_pubkey text,
  p_plan_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  DELETE FROM public.subscription_plans
  WHERE id = p_plan_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Get subscription plans (replaces get_subscription_plans_for_solana)
CREATE OR REPLACE FUNCTION public.get_subscription_plans_by_pubkey(p_pubkey text)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  name text,
  description text,
  price_per_week_sats integer,
  meal_time time,
  max_duration_weeks integer,
  supports_delivery boolean,
  is_active boolean,
  menu_category menu_category,
  created_at timestamptz,
  updated_at timestamptz
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
  WHERE u.lightning_pubkey = p_pubkey;
  
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

-- Create subscription (replaces create_subscription_for_solana, Lightning-only)
CREATE OR REPLACE FUNCTION public.create_subscription_by_pubkey(
  p_pubkey text,
  p_restaurant_id uuid,
  p_plan_id uuid,
  p_start_date date,
  p_end_date date,
  p_duration_weeks integer,
  p_total_price_sats integer,
  p_payment_reference text
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  restaurant_id uuid,
  plan_id uuid,
  start_date date,
  end_date date,
  duration_weeks integer,
  total_price_sats integer,
  payment_method payment_method,
  payment_reference text,
  payment_status payment_status,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_subscription_id UUID;
BEGIN
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for pubkey';
  END IF;
  
  INSERT INTO public.subscriptions (
    user_id, restaurant_id, plan_id, start_date, end_date,
    duration_weeks, total_price_sats,
    payment_method, payment_reference, payment_status, is_active
  )
  VALUES (
    v_user_id, p_restaurant_id, p_plan_id, p_start_date, p_end_date,
    p_duration_weeks, p_total_price_sats,
    'lightning', p_payment_reference, 'paid', true
  )
  RETURNING subscriptions.id INTO v_subscription_id;
  
  PERFORM public.generate_meal_choices_for_subscription(v_subscription_id);
  
  RETURN QUERY
  SELECT 
    s.id, s.user_id, s.restaurant_id, s.plan_id, s.start_date, s.end_date,
    s.duration_weeks, s.total_price_sats,
    s.payment_method, s.payment_reference, s.payment_status, s.is_active
  FROM public.subscriptions s
  WHERE s.id = v_subscription_id;
END;
$$;

-- Get user's restaurant ID by pubkey (replaces get_solana_user_restaurant_id)
CREATE OR REPLACE FUNCTION public.get_user_restaurant_id(p_pubkey text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT restaurant_id INTO v_restaurant_id
  FROM public.users
  WHERE lightning_pubkey = p_pubkey;
  
  RETURN v_restaurant_id;
END;
$$;

-- Link user to restaurant (replaces link_solana_user_to_restaurant)
CREATE OR REPLACE FUNCTION public.link_user_to_restaurant(
  p_pubkey text,
  p_restaurant_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET restaurant_id = p_restaurant_id
  WHERE lightning_pubkey = p_pubkey;
END;
$$;

-- Create restaurant for user (replaces create_restaurant_for_solana_user)
CREATE OR REPLACE FUNCTION public.create_restaurant_for_user(
  p_pubkey text,
  p_name text,
  p_description text DEFAULT NULL,
  p_address text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_restaurant_id UUID;
BEGIN
  SELECT id INTO v_user_id
  FROM public.users
  WHERE lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for pubkey';
  END IF;
  
  INSERT INTO public.restaurants (name, description, address, is_active)
  VALUES (p_name, p_description, p_address, true)
  RETURNING id INTO v_restaurant_id;
  
  UPDATE public.users
  SET restaurant_id = v_restaurant_id
  WHERE id = v_user_id;
  
  RETURN v_restaurant_id;
END;
$$;

-- 6. Drop old Solana-specific functions (cleanup)
DROP FUNCTION IF EXISTS public.get_or_create_solana_user(text);
DROP FUNCTION IF EXISTS public.update_solana_user_email(text, text);
DROP FUNCTION IF EXISTS public.set_solana_session(text);
DROP FUNCTION IF EXISTS public.get_user_profile_for_solana(text);
DROP FUNCTION IF EXISTS public.upsert_user_profile_for_solana(text, text, text, text[], meal_type, jsonb);
DROP FUNCTION IF EXISTS public.upsert_user_profile_for_solana(text, text, text, text, text[], meal_type, jsonb);
DROP FUNCTION IF EXISTS public.get_solana_user_restaurant_id(text);
DROP FUNCTION IF EXISTS public.link_solana_user_to_restaurant(text, uuid);
DROP FUNCTION IF EXISTS public.create_restaurant_for_solana_user(text, text, text, text);
DROP FUNCTION IF EXISTS public.create_menu_item_for_solana(text, uuid, day_of_week, text, text, text[], text);
DROP FUNCTION IF EXISTS public.create_menu_item_for_solana(text, uuid, day_of_week, meal_type_slot, text, text, text[], text);
DROP FUNCTION IF EXISTS public.update_menu_item_for_solana(text, uuid, text, text, text[], text);
DROP FUNCTION IF EXISTS public.delete_menu_item_for_solana(text, uuid);
DROP FUNCTION IF EXISTS public.update_menu_status_for_solana(text, uuid, menu_status);
DROP FUNCTION IF EXISTS public.get_weekly_menus_for_solana(text, date, date);
DROP FUNCTION IF EXISTS public.create_weekly_menu_for_solana(text, date, date, menu_category);
DROP FUNCTION IF EXISTS public.create_subscription_plan_for_solana(text, text, integer, numeric, text, time, integer, boolean, boolean, menu_category);
DROP FUNCTION IF EXISTS public.update_subscription_plan_for_solana(text, uuid, text, integer, numeric, text, time, integer, boolean, boolean, menu_category);
DROP FUNCTION IF EXISTS public.delete_subscription_plan_for_solana(text, uuid);
DROP FUNCTION IF EXISTS public.get_subscription_plans_for_solana(text);
DROP FUNCTION IF EXISTS public.get_restaurant_wallet_for_solana(text);
DROP FUNCTION IF EXISTS public.upsert_restaurant_wallet_for_solana(text, lightning_wallet_type, text, text, text);
DROP FUNCTION IF EXISTS public.create_subscription_for_solana(text, uuid, uuid, date, date, integer, integer, numeric, payment_method, text);

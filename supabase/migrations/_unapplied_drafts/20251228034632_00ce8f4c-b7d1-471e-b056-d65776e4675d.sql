-- =====================================================
-- SECURITY FIX 5: Secure restaurant admin functions
-- =====================================================

-- Fix get_restaurant_orders_by_pubkey to validate session
CREATE OR REPLACE FUNCTION public.get_restaurant_orders_by_pubkey(p_pubkey text)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  user_name text,
  status order_status,
  total_sats integer,
  delivery_address jsonb,
  customer_notes text,
  created_at timestamp with time zone,
  items jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    o.id,
    o.user_id,
    COALESCE(u.display_name, u.name, 'Customer') as user_name,
    o.status,
    o.total_sats,
    o.delivery_address,
    o.customer_notes,
    o.created_at,
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', oi.id,
        'product_name', p.name,
        'quantity', oi.quantity,
        'unit_price_sats', oi.unit_price_sats
      ))
      FROM public.order_items oi
      JOIN public.products p ON p.id = oi.product_id
      WHERE oi.order_id = o.id),
      '[]'::jsonb
    ) as items
  FROM public.orders o
  JOIN public.users u ON u.id = o.user_id
  WHERE o.restaurant_id = v_restaurant_id
  ORDER BY o.created_at DESC;
END;
$$;

-- Fix update_order_status_by_pubkey to validate session
CREATE OR REPLACE FUNCTION public.update_order_status_by_pubkey(p_pubkey text, p_order_id uuid, p_status order_status)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Not a restaurant admin';
  END IF;
  
  UPDATE public.orders
  SET status = p_status, updated_at = now()
  WHERE id = p_order_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Fix create_product_by_pubkey to validate session
CREATE OR REPLACE FUNCTION public.create_product_by_pubkey(
  p_pubkey text,
  p_name text,
  p_price_sats integer,
  p_description text DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_is_available boolean DEFAULT true
)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  name text,
  description text,
  price_sats integer,
  image_url text,
  category text,
  is_available boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  -- SECURITY: Validate price is positive
  IF p_price_sats IS NULL OR p_price_sats < 0 THEN
    RAISE EXCEPTION 'Price must be non-negative';
  END IF;
  
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  RETURN QUERY
  INSERT INTO public.products (restaurant_id, name, description, price_sats, image_url, category, is_available)
  VALUES (v_restaurant_id, p_name, p_description, p_price_sats, p_image_url, p_category, p_is_available)
  RETURNING products.id, products.restaurant_id, products.name, products.description, products.price_sats, products.image_url, products.category, products.is_available;
END;
$$;

-- Fix update_product_by_pubkey to validate session
CREATE OR REPLACE FUNCTION public.update_product_by_pubkey(
  p_pubkey text,
  p_product_id uuid,
  p_name text,
  p_price_sats integer,
  p_description text DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_is_available boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  -- SECURITY: Validate price is positive
  IF p_price_sats IS NULL OR p_price_sats < 0 THEN
    RAISE EXCEPTION 'Price must be non-negative';
  END IF;
  
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  UPDATE public.products
  SET name = p_name, description = p_description, price_sats = p_price_sats, 
      image_url = p_image_url, category = p_category, is_available = p_is_available, updated_at = now()
  WHERE id = p_product_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Fix delete_product_by_pubkey to validate session
CREATE OR REPLACE FUNCTION public.delete_product_by_pubkey(p_pubkey text, p_product_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  DELETE FROM public.products
  WHERE id = p_product_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Fix menu item functions
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
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
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
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
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

CREATE OR REPLACE FUNCTION public.delete_menu_item_by_pubkey(p_pubkey text, p_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_restaurant_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
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

-- Fix driver functions
CREATE OR REPLACE FUNCTION public.claim_order_for_delivery(p_pubkey text, p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id UUID;
  v_has_driver_role BOOLEAN;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.id INTO v_driver_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  
  -- Check if user has driver role
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = v_driver_id AND role = 'driver'
  ) INTO v_has_driver_role;
  
  IF NOT v_has_driver_role THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  
  -- Claim the order if it's ready and not assigned
  UPDATE public.orders
  SET driver_id = v_driver_id, updated_at = now()
  WHERE id = p_order_id 
    AND status = 'ready' 
    AND driver_id IS NULL
    AND delivery_address IS NOT NULL;
  
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_order_status_by_driver(p_pubkey text, p_order_id uuid, p_status order_status)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.id INTO v_driver_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  
  -- Only allow drivers to update their own assigned orders
  UPDATE public.orders
  SET status = p_status, updated_at = now()
  WHERE id = p_order_id AND driver_id = v_driver_id;
  
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_driver_orders_by_pubkey(p_pubkey text)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  restaurant_name text,
  restaurant_address text,
  user_id uuid,
  customer_name text,
  status order_status,
  total_sats integer,
  delivery_address jsonb,
  customer_notes text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  items jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.id INTO v_driver_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    o.id,
    o.restaurant_id,
    r.name as restaurant_name,
    r.address as restaurant_address,
    o.user_id,
    COALESCE(cu.display_name, cu.name, 'Customer') as customer_name,
    o.status,
    o.total_sats,
    o.delivery_address,
    o.customer_notes,
    o.created_at,
    o.updated_at,
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', oi.id,
        'product_name', p.name,
        'quantity', oi.quantity,
        'unit_price_sats', oi.unit_price_sats
      ))
      FROM public.order_items oi
      JOIN public.products p ON p.id = oi.product_id
      WHERE oi.order_id = o.id),
      '[]'::jsonb
    ) as items
  FROM public.orders o
  JOIN public.restaurants r ON r.id = o.restaurant_id
  JOIN public.users cu ON cu.id = o.user_id
  WHERE o.driver_id = v_driver_id
  ORDER BY 
    CASE o.status 
      WHEN 'out_for_delivery' THEN 1
      WHEN 'ready' THEN 2
      ELSE 3
    END,
    o.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_driver_delivery_history(p_pubkey text)
RETURNS TABLE(
  id uuid,
  restaurant_name text,
  customer_name text,
  status order_status,
  total_sats integer,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.id INTO v_driver_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    o.id,
    r.name as restaurant_name,
    COALESCE(cu.display_name, cu.name, 'Customer') as customer_name,
    o.status,
    o.total_sats,
    o.created_at,
    o.updated_at
  FROM public.orders o
  JOIN public.restaurants r ON r.id = o.restaurant_id
  JOIN public.users cu ON cu.id = o.user_id
  WHERE o.driver_id = v_driver_id
    AND o.status IN ('delivered', 'cancelled')
  ORDER BY o.updated_at DESC
  LIMIT 50;
END;
$$;
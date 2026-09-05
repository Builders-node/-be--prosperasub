-- =====================================================
-- SECURITY FIX 1: Fix NWC functions to use session-based auth
-- This prevents attackers from reading/modifying other users' wallet credentials
-- =====================================================

-- Create secure version of get_user_nwc_connection that uses authenticated session
CREATE OR REPLACE FUNCTION public.get_user_nwc_connection(p_pubkey text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_nwc TEXT;
  v_session_pubkey TEXT;
BEGIN
  -- Get the session pubkey (set by lnurl-auth Edge Function after verification)
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  -- SECURITY: Only allow access if the requested pubkey matches the authenticated session
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT nwc_connection_string INTO v_nwc 
  FROM public.users 
  WHERE lightning_pubkey = p_pubkey;
  
  RETURN v_nwc;
END;
$$;

-- Create secure version of update_user_nwc_connection
CREATE OR REPLACE FUNCTION public.update_user_nwc_connection(p_pubkey text, p_nwc_connection text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_session_pubkey TEXT;
BEGIN
  -- Get the session pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  -- SECURITY: Only allow access if the requested pubkey matches the authenticated session
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT id INTO v_user_id FROM public.users WHERE lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  
  UPDATE public.users
  SET nwc_connection_string = p_nwc_connection
  WHERE id = v_user_id;
END;
$$;

-- =====================================================
-- SECURITY FIX 2: Add server-side validation to create_order_by_pubkey
-- This prevents price manipulation, negative quantities, and invalid products
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_order_by_pubkey(
  p_pubkey text,
  p_restaurant_id uuid,
  p_total_sats integer,
  p_items jsonb,
  p_delivery_address jsonb DEFAULT NULL,
  p_customer_notes text DEFAULT NULL,
  p_payment_hash text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  restaurant_id uuid,
  status order_status,
  total_sats integer,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_order_id UUID;
  v_item JSONB;
  v_session_pubkey TEXT;
  v_product_id UUID;
  v_actual_price INTEGER;
  v_quantity INTEGER;
  v_calculated_total INTEGER := 0;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  -- Get user ID
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  
  -- Validate JSONB items array is not empty
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;
  
  -- Create the order first
  INSERT INTO public.orders (user_id, restaurant_id, total_sats, delivery_address, customer_notes, status)
  VALUES (v_user_id, p_restaurant_id, 0, p_delivery_address, p_customer_notes, 'confirmed')
  RETURNING orders.id INTO v_order_id;
  
  -- Process and validate each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Safely extract and validate product_id
    BEGIN
      v_product_id := (v_item->>'product_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid product ID format';
    END;
    
    -- Safely extract and validate quantity
    BEGIN
      v_quantity := (v_item->>'quantity')::INTEGER;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid quantity format';
    END;
    
    -- SECURITY: Validate quantity is positive
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantity must be greater than 0';
    END IF;
    
    -- SECURITY: Validate quantity is reasonable (max 100 per item)
    IF v_quantity > 100 THEN
      RAISE EXCEPTION 'Quantity exceeds maximum allowed (100)';
    END IF;
    
    -- SECURITY: Fetch actual price from products table - never trust client price!
    SELECT p.price_sats INTO v_actual_price
    FROM public.products p
    WHERE p.id = v_product_id
      AND p.restaurant_id = p_restaurant_id
      AND p.is_available = true;
    
    IF v_actual_price IS NULL THEN
      RAISE EXCEPTION 'Product not found, unavailable, or does not belong to this restaurant';
    END IF;
    
    -- Insert order item with SERVER-SIDE verified price
    INSERT INTO public.order_items (order_id, product_id, quantity, unit_price_sats)
    VALUES (v_order_id, v_product_id, v_quantity, v_actual_price);
    
    -- Calculate running total
    v_calculated_total := v_calculated_total + (v_actual_price * v_quantity);
  END LOOP;
  
  -- SECURITY: Validate total matches what client sent (with small tolerance for rounding)
  IF ABS(v_calculated_total - p_total_sats) > 1 THEN
    -- Delete the order if total doesn't match
    DELETE FROM public.order_items WHERE order_items.order_id = v_order_id;
    DELETE FROM public.orders WHERE orders.id = v_order_id;
    RAISE EXCEPTION 'Order total mismatch. Expected: %, Received: %', v_calculated_total, p_total_sats;
  END IF;
  
  -- Update order with correct server-calculated total
  UPDATE public.orders
  SET total_sats = v_calculated_total
  WHERE orders.id = v_order_id;
  
  -- Create payment record
  INSERT INTO public.payments (user_id, payment_type, reference_id, amount_sats, payment_hash, status)
  VALUES (v_user_id, 'order', v_order_id, v_calculated_total, p_payment_hash, 'paid');
  
  -- Return the created order
  RETURN QUERY
  SELECT o.id, o.user_id, o.restaurant_id, o.status, o.total_sats, o.created_at
  FROM public.orders o
  WHERE o.id = v_order_id;
END;
$$;

-- =====================================================
-- SECURITY FIX 3: Add CHECK constraints to order_items table
-- Additional protection against invalid data
-- =====================================================

-- Add check constraint for positive quantity
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_quantity_positive'
  ) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0);
  END IF;
END $$;

-- Add check constraint for positive price
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_price_positive'
  ) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_price_positive CHECK (unit_price_sats >= 0);
  END IF;
END $$;

-- =====================================================
-- SECURITY FIX 4: Secure other critical functions with session validation
-- =====================================================

-- Fix create_subscription_by_pubkey to validate session
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
  payment_reference text,
  payment_status payment_status,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_subscription_id UUID;
  v_session_pubkey TEXT;
  v_plan_price INTEGER;
  v_calculated_total INTEGER;
BEGIN
  -- SECURITY: Validate session matches requested pubkey
  v_session_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_session_pubkey IS NULL OR v_session_pubkey = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  IF v_session_pubkey != p_pubkey THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  
  -- SECURITY: Validate plan exists and get actual price
  SELECT sp.price_per_week_sats INTO v_plan_price
  FROM public.subscription_plans sp
  WHERE sp.id = p_plan_id
    AND sp.restaurant_id = p_restaurant_id
    AND sp.is_active = true;
  
  IF v_plan_price IS NULL THEN
    RAISE EXCEPTION 'Plan not found or not active';
  END IF;
  
  -- SECURITY: Validate total matches plan price * weeks
  v_calculated_total := v_plan_price * p_duration_weeks;
  IF v_calculated_total != p_total_price_sats THEN
    RAISE EXCEPTION 'Price mismatch';
  END IF;
  
  INSERT INTO public.subscriptions (
    user_id, restaurant_id, plan_id, start_date, end_date,
    duration_weeks, total_price_sats,
    payment_method, payment_reference, payment_status, is_active
  )
  VALUES (
    v_user_id, p_restaurant_id, p_plan_id, p_start_date, p_end_date,
    p_duration_weeks, v_calculated_total,
    'lightning', p_payment_reference, 'paid', true
  )
  RETURNING subscriptions.id INTO v_subscription_id;
  
  PERFORM public.generate_meal_choices_for_subscription(v_subscription_id);
  
  RETURN QUERY
  SELECT 
    s.id, s.user_id, s.restaurant_id, s.plan_id, s.start_date, s.end_date,
    s.duration_weeks, s.total_price_sats,
    s.payment_reference, s.payment_status, s.is_active
  FROM public.subscriptions s
  WHERE s.id = v_subscription_id;
END;
$$;

-- Fix get_user_orders_by_pubkey to validate session
CREATE OR REPLACE FUNCTION public.get_user_orders_by_pubkey(p_pubkey text)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  restaurant_name text,
  status order_status,
  total_sats integer,
  created_at timestamp with time zone,
  items jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
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
  
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    o.id,
    o.restaurant_id,
    r.name as restaurant_name,
    o.status,
    o.total_sats,
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
  JOIN public.restaurants r ON r.id = o.restaurant_id
  WHERE o.user_id = v_user_id
  ORDER BY o.created_at DESC;
END;
$$;

-- Fix get_user_profile to validate session
CREATE OR REPLACE FUNCTION public.get_user_profile(p_pubkey text)
RETURNS TABLE(
  id uuid,
  lightning_pubkey text,
  display_name text,
  avatar_url text,
  created_at timestamp with time zone,
  last_login_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
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
  
  RETURN QUERY
  SELECT u.id, u.lightning_pubkey, u.display_name, u.avatar_url, u.created_at, u.last_login_at
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
END;
$$;

-- Fix update_user_profile to validate session
CREATE OR REPLACE FUNCTION public.update_user_profile(p_pubkey text, p_display_name text, p_avatar_url text)
RETURNS TABLE(
  id uuid,
  lightning_pubkey text,
  display_name text,
  avatar_url text,
  created_at timestamp with time zone,
  last_login_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
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
  
  RETURN QUERY
  UPDATE public.users u
  SET 
    display_name = p_display_name,
    avatar_url = p_avatar_url
  WHERE u.lightning_pubkey = p_pubkey
  RETURNING u.id, u.lightning_pubkey, u.display_name, u.avatar_url, u.created_at, u.last_login_at;
END;
$$;

-- Fix get_user_tournament_application to validate session
CREATE OR REPLACE FUNCTION public.get_user_tournament_application(p_pubkey text)
RETURNS TABLE(
  id uuid,
  name text,
  email text,
  telegram_username text,
  chess_com_account text,
  current_rating integer,
  highest_rating integer,
  payment_status text,
  amount_sats integer,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
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
  
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    ta.id,
    ta.name,
    ta.email,
    ta.telegram_username,
    ta.chess_com_account,
    ta.current_rating,
    ta.highest_rating,
    ta.payment_status,
    ta.amount_sats,
    ta.created_at
  FROM public.tournament_applications ta
  WHERE ta.user_id = v_user_id
  ORDER BY ta.created_at DESC
  LIMIT 1;
END;
$$;
-- Create RPC functions for driver operations

-- Get available orders for pickup (orders that are ready and not assigned)
CREATE OR REPLACE FUNCTION public.get_available_orders_for_driver()
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  restaurant_name TEXT,
  restaurant_address TEXT,
  status order_status,
  total_sats INTEGER,
  delivery_address JSONB,
  customer_notes TEXT,
  created_at TIMESTAMPTZ,
  items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    o.id,
    o.restaurant_id,
    r.name as restaurant_name,
    r.address as restaurant_address,
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
  JOIN public.restaurants r ON r.id = o.restaurant_id
  WHERE o.status = 'ready' AND o.driver_id IS NULL
    AND o.delivery_address IS NOT NULL
  ORDER BY o.created_at ASC;
END;
$$;

-- Get driver's assigned orders
CREATE OR REPLACE FUNCTION public.get_driver_orders_by_pubkey(p_pubkey TEXT)
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  restaurant_name TEXT,
  restaurant_address TEXT,
  user_id UUID,
  customer_name TEXT,
  status order_status,
  total_sats INTEGER,
  delivery_address JSONB,
  customer_notes TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id UUID;
BEGIN
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

-- Claim an order for delivery
CREATE OR REPLACE FUNCTION public.claim_order_for_delivery(p_pubkey TEXT, p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id UUID;
  v_has_driver_role BOOLEAN;
BEGIN
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
    RAISE EXCEPTION 'User is not a driver';
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

-- Update order status by driver
CREATE OR REPLACE FUNCTION public.update_order_status_by_driver(p_pubkey TEXT, p_order_id UUID, p_status order_status)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id UUID;
BEGIN
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

-- Get driver delivery history
CREATE OR REPLACE FUNCTION public.get_driver_delivery_history(p_pubkey TEXT)
RETURNS TABLE(
  id UUID,
  restaurant_name TEXT,
  customer_name TEXT,
  status order_status,
  total_sats INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id UUID;
BEGIN
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
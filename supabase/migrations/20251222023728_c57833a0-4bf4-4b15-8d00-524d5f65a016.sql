
-- Phase 3: Order Once Feature - Create products, orders, order_items, and payments tables

-- Create order_status enum
CREATE TYPE public.order_status AS ENUM ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled');

-- Create payment_type enum to distinguish subscription vs order payments
CREATE TYPE public.payment_type AS ENUM ('subscription', 'order');

-- Create products table
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_sats INTEGER NOT NULL CHECK (price_sats > 0),
  image_url TEXT,
  category TEXT,
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create orders table
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  status order_status DEFAULT 'pending',
  total_sats INTEGER NOT NULL CHECK (total_sats >= 0),
  delivery_address JSONB,
  customer_notes TEXT,
  driver_id UUID REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create order_items table
CREATE TABLE public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_sats INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create unified payments table
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  payment_type payment_type NOT NULL,
  reference_id UUID NOT NULL, -- subscription_id or order_id
  amount_sats INTEGER NOT NULL CHECK (amount_sats > 0),
  payment_method public.payment_method DEFAULT 'lightning',
  payment_hash TEXT,
  status public.payment_status DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS on all new tables
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- Products RLS policies
CREATE POLICY "Anyone can view available products" ON public.products
  FOR SELECT USING (is_available = true);

CREATE POLICY "Restaurant admins can manage their products" ON public.products
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id() AND u.restaurant_id = products.restaurant_id
    )
  );

CREATE POLICY "Super admins can manage all products" ON public.products
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

-- Orders RLS policies
CREATE POLICY "Users can view and create their own orders" ON public.orders
  FOR ALL USING (user_id = get_current_user_id());

CREATE POLICY "Restaurant admins can view orders for their restaurant" ON public.orders
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id() AND u.restaurant_id = orders.restaurant_id
    )
  );

CREATE POLICY "Restaurant admins can update orders for their restaurant" ON public.orders
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id() AND u.restaurant_id = orders.restaurant_id
    )
  );

CREATE POLICY "Drivers can view assigned orders" ON public.orders
  FOR SELECT USING (driver_id = get_current_user_id());

CREATE POLICY "Drivers can update assigned orders" ON public.orders
  FOR UPDATE USING (driver_id = get_current_user_id());

CREATE POLICY "Super admins can manage all orders" ON public.orders
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

-- Order items RLS policies
CREATE POLICY "Users can view their order items" ON public.order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id AND o.user_id = get_current_user_id()
    )
  );

CREATE POLICY "Users can insert order items for their orders" ON public.order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id AND o.user_id = get_current_user_id()
    )
  );

CREATE POLICY "Restaurant admins can view order items for their restaurant" ON public.order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      JOIN public.users u ON u.restaurant_id = o.restaurant_id
      WHERE o.id = order_items.order_id AND u.id = get_current_user_id()
    )
  );

CREATE POLICY "Super admins can manage all order items" ON public.order_items
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

-- Payments RLS policies
CREATE POLICY "Users can view their own payments" ON public.payments
  FOR SELECT USING (user_id = get_current_user_id());

CREATE POLICY "Users can create their own payments" ON public.payments
  FOR INSERT WITH CHECK (user_id = get_current_user_id());

CREATE POLICY "Super admins can manage all payments" ON public.payments
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

-- Create updated_at triggers
CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create RPC functions for products
CREATE OR REPLACE FUNCTION public.get_products_by_restaurant(p_restaurant_id UUID)
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  name TEXT,
  description TEXT,
  price_sats INTEGER,
  image_url TEXT,
  category TEXT,
  is_available BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.restaurant_id, p.name, p.description, p.price_sats, p.image_url, p.category, p.is_available
  FROM public.products p
  WHERE p.restaurant_id = p_restaurant_id AND p.is_available = true;
$$;

-- Create RPC for restaurant admin to manage products
CREATE OR REPLACE FUNCTION public.create_product_by_pubkey(
  p_pubkey TEXT,
  p_name TEXT,
  p_price_sats INTEGER,
  p_description TEXT DEFAULT NULL,
  p_image_url TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_is_available BOOLEAN DEFAULT true
)
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  name TEXT,
  description TEXT,
  price_sats INTEGER,
  image_url TEXT,
  category TEXT,
  is_available BOOLEAN
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
  INSERT INTO public.products (restaurant_id, name, description, price_sats, image_url, category, is_available)
  VALUES (v_restaurant_id, p_name, p_description, p_price_sats, p_image_url, p_category, p_is_available)
  RETURNING products.id, products.restaurant_id, products.name, products.description, products.price_sats, products.image_url, products.category, products.is_available;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_product_by_pubkey(
  p_pubkey TEXT,
  p_product_id UUID,
  p_name TEXT,
  p_price_sats INTEGER,
  p_description TEXT DEFAULT NULL,
  p_image_url TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_is_available BOOLEAN DEFAULT true
)
RETURNS BOOLEAN
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
  
  UPDATE public.products
  SET name = p_name, description = p_description, price_sats = p_price_sats, 
      image_url = p_image_url, category = p_category, is_available = p_is_available, updated_at = now()
  WHERE id = p_product_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_product_by_pubkey(p_pubkey TEXT, p_product_id UUID)
RETURNS BOOLEAN
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
  
  DELETE FROM public.products
  WHERE id = p_product_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Create RPC for creating orders
CREATE OR REPLACE FUNCTION public.create_order_by_pubkey(
  p_pubkey TEXT,
  p_restaurant_id UUID,
  p_total_sats INTEGER,
  p_items JSONB, -- array of {product_id, quantity, unit_price_sats}
  p_delivery_address JSONB DEFAULT NULL,
  p_customer_notes TEXT DEFAULT NULL,
  p_payment_hash TEXT DEFAULT NULL
)
RETURNS TABLE(
  id UUID,
  user_id UUID,
  restaurant_id UUID,
  status order_status,
  total_sats INTEGER,
  created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_order_id UUID;
  v_item JSONB;
BEGIN
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for pubkey';
  END IF;
  
  -- Create the order
  INSERT INTO public.orders (user_id, restaurant_id, total_sats, delivery_address, customer_notes, status)
  VALUES (v_user_id, p_restaurant_id, p_total_sats, p_delivery_address, p_customer_notes, 'confirmed')
  RETURNING orders.id INTO v_order_id;
  
  -- Insert order items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.order_items (order_id, product_id, quantity, unit_price_sats)
    VALUES (
      v_order_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'quantity')::INTEGER,
      (v_item->>'unit_price_sats')::INTEGER
    );
  END LOOP;
  
  -- Create payment record
  INSERT INTO public.payments (user_id, payment_type, reference_id, amount_sats, payment_hash, status)
  VALUES (v_user_id, 'order', v_order_id, p_total_sats, p_payment_hash, 'paid');
  
  RETURN QUERY
  SELECT o.id, o.user_id, o.restaurant_id, o.status, o.total_sats, o.created_at
  FROM public.orders o
  WHERE o.id = v_order_id;
END;
$$;

-- Get user orders
CREATE OR REPLACE FUNCTION public.get_user_orders_by_pubkey(p_pubkey TEXT)
RETURNS TABLE(
  id UUID,
  restaurant_id UUID,
  restaurant_name TEXT,
  status order_status,
  total_sats INTEGER,
  created_at TIMESTAMP WITH TIME ZONE,
  items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
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

-- Get restaurant orders for admin
CREATE OR REPLACE FUNCTION public.get_restaurant_orders_by_pubkey(p_pubkey TEXT)
RETURNS TABLE(
  id UUID,
  user_id UUID,
  user_name TEXT,
  status order_status,
  total_sats INTEGER,
  delivery_address JSONB,
  customer_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  items JSONB
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

-- Update order status
CREATE OR REPLACE FUNCTION public.update_order_status_by_pubkey(
  p_pubkey TEXT,
  p_order_id UUID,
  p_status order_status
)
RETURNS BOOLEAN
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
  
  UPDATE public.orders
  SET status = p_status, updated_at = now()
  WHERE id = p_order_id AND restaurant_id = v_restaurant_id;
  
  RETURN FOUND;
END;
$$;

-- Function to get Solana user's restaurant_id
CREATE OR REPLACE FUNCTION public.get_solana_user_restaurant_id(p_wallet_address TEXT)
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
  WHERE email = p_wallet_address || '@solana.wallet';
  
  RETURN v_restaurant_id;
END;
$$;

-- Function to link Solana user to a restaurant
CREATE OR REPLACE FUNCTION public.link_solana_user_to_restaurant(p_wallet_address TEXT, p_restaurant_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET restaurant_id = p_restaurant_id
  WHERE email = p_wallet_address || '@solana.wallet';
END;
$$;

-- Function to create a restaurant for Solana user (restaurant admin)
CREATE OR REPLACE FUNCTION public.create_restaurant_for_solana_user(
  p_wallet_address TEXT,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_address TEXT DEFAULT NULL
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
  -- Get user_id
  SELECT id INTO v_user_id
  FROM public.users
  WHERE email = p_wallet_address || '@solana.wallet';
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for wallet';
  END IF;
  
  -- Create restaurant
  INSERT INTO public.restaurants (name, description, address, is_active)
  VALUES (p_name, p_description, p_address, true)
  RETURNING id INTO v_restaurant_id;
  
  -- Link user to restaurant
  UPDATE public.users
  SET restaurant_id = v_restaurant_id
  WHERE id = v_user_id;
  
  RETURN v_restaurant_id;
END;
$$;
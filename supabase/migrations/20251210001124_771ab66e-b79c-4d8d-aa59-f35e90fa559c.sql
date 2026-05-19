-- Function to get user profile for Solana users
CREATE OR REPLACE FUNCTION public.get_user_profile_for_solana(p_wallet_address TEXT)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  phone_number TEXT,
  telegram_username TEXT,
  food_preferences TEXT[],
  default_meal_type meal_type,
  default_delivery_address JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id 
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    up.id,
    up.user_id,
    up.phone_number,
    up.telegram_username,
    up.food_preferences,
    up.default_meal_type,
    up.default_delivery_address
  FROM public.user_profiles up
  WHERE up.user_id = v_user_id;
END;
$$;

-- Function to upsert user profile for Solana users
CREATE OR REPLACE FUNCTION public.upsert_user_profile_for_solana(
  p_wallet_address TEXT,
  p_phone_number TEXT DEFAULT NULL,
  p_telegram_username TEXT DEFAULT NULL,
  p_food_preferences TEXT[] DEFAULT '{}',
  p_default_meal_type meal_type DEFAULT 'eat_in',
  p_default_delivery_address JSONB DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id 
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for wallet';
  END IF;
  
  INSERT INTO public.user_profiles (
    user_id, phone_number, telegram_username, 
    food_preferences, default_meal_type, default_delivery_address
  )
  VALUES (
    v_user_id, p_phone_number, p_telegram_username,
    p_food_preferences, p_default_meal_type, p_default_delivery_address
  )
  ON CONFLICT (user_id) DO UPDATE SET
    phone_number = EXCLUDED.phone_number,
    telegram_username = EXCLUDED.telegram_username,
    food_preferences = EXCLUDED.food_preferences,
    default_meal_type = EXCLUDED.default_meal_type,
    default_delivery_address = EXCLUDED.default_delivery_address,
    updated_at = now();
END;
$$;
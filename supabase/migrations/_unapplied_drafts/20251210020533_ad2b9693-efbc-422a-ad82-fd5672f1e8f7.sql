CREATE OR REPLACE FUNCTION public.upsert_user_profile_for_solana(
  p_wallet_address TEXT,
  p_display_name TEXT DEFAULT NULL,
  p_phone_number TEXT DEFAULT NULL,
  p_telegram_username TEXT DEFAULT NULL,
  p_food_preferences TEXT[] DEFAULT '{}'::TEXT[],
  p_default_meal_type meal_type DEFAULT 'eat_in'::meal_type,
  p_default_delivery_address JSONB DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Find and update user's display_name
  UPDATE public.users 
  SET 
    display_name = COALESCE(p_display_name, display_name),
    name = COALESCE(p_display_name, name)
  WHERE email = p_wallet_address || '@solana.wallet'
  RETURNING id INTO v_user_id;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for wallet';
  END IF;
  
  -- Upsert user profile
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
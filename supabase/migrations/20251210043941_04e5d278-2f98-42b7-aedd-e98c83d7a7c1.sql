-- Function to get restaurant wallet for Solana user
CREATE OR REPLACE FUNCTION public.get_restaurant_wallet_for_solana(p_wallet_address text)
RETURNS TABLE(
  id uuid,
  restaurant_id uuid,
  lightning_type lightning_wallet_type,
  lightning_identifier text,
  lightning_api_key text,
  solana_wallet_address text,
  test_mode boolean,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
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
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    rw.id,
    rw.restaurant_id,
    rw.lightning_type,
    rw.lightning_identifier,
    rw.lightning_api_key,
    rw.solana_wallet_address,
    rw.test_mode,
    rw.created_at,
    rw.updated_at
  FROM public.restaurant_wallets rw
  WHERE rw.restaurant_id = v_restaurant_id;
END;
$$;

-- Function to upsert restaurant wallet for Solana user
CREATE OR REPLACE FUNCTION public.upsert_restaurant_wallet_for_solana(
  p_wallet_address text,
  p_lightning_type lightning_wallet_type DEFAULT NULL,
  p_lightning_identifier text DEFAULT NULL,
  p_lightning_api_key text DEFAULT NULL,
  p_solana_wallet_address text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
  v_existing_wallet_id UUID;
BEGIN
  SELECT u.restaurant_id INTO v_restaurant_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'User is not linked to a restaurant';
  END IF;
  
  -- Check if wallet already exists
  SELECT id INTO v_existing_wallet_id
  FROM public.restaurant_wallets
  WHERE restaurant_id = v_restaurant_id;
  
  IF v_existing_wallet_id IS NOT NULL THEN
    -- Update existing wallet
    UPDATE public.restaurant_wallets
    SET 
      lightning_type = COALESCE(p_lightning_type, lightning_type),
      lightning_identifier = COALESCE(p_lightning_identifier, lightning_identifier),
      lightning_api_key = COALESCE(p_lightning_api_key, lightning_api_key),
      solana_wallet_address = COALESCE(p_solana_wallet_address, solana_wallet_address),
      updated_at = now()
    WHERE id = v_existing_wallet_id;
  ELSE
    -- Insert new wallet
    INSERT INTO public.restaurant_wallets (
      restaurant_id, lightning_type, lightning_identifier, 
      lightning_api_key, solana_wallet_address
    )
    VALUES (
      v_restaurant_id, p_lightning_type, p_lightning_identifier,
      p_lightning_api_key, p_solana_wallet_address
    );
  END IF;
  
  RETURN true;
END;
$$;
-- Update get_current_user_id to support both Lightning and Solana users
CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pubkey TEXT;
  v_solana_wallet TEXT;
  v_user_id UUID;
BEGIN
  -- Check for Lightning pubkey first
  v_pubkey := current_setting('app.current_pubkey', true);
  IF v_pubkey IS NOT NULL AND v_pubkey != '' THEN
    SELECT id INTO v_user_id FROM public.users WHERE lightning_pubkey = v_pubkey;
    IF v_user_id IS NOT NULL THEN
      RETURN v_user_id;
    END IF;
  END IF;
  
  -- Check for Solana wallet
  v_solana_wallet := current_setting('app.current_solana_wallet', true);
  IF v_solana_wallet IS NOT NULL AND v_solana_wallet != '' THEN
    SELECT id INTO v_user_id FROM public.users 
    WHERE email = v_solana_wallet || '@solana.wallet';
    RETURN v_user_id;
  END IF;
  
  RETURN NULL;
END;
$function$;

-- Create helper function to set Solana session variable
CREATE OR REPLACE FUNCTION public.set_solana_session(p_wallet_address text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.current_solana_wallet', p_wallet_address, false);
END;
$function$;
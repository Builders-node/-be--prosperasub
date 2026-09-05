-- Create set_lightning_session function to match set_solana_session
CREATE OR REPLACE FUNCTION public.set_lightning_session(p_pubkey text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM set_config('app.current_pubkey', p_pubkey, false);
END;
$$;
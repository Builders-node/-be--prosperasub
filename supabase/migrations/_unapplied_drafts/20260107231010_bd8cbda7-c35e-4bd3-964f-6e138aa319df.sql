CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pubkey TEXT;
  v_user_id UUID;
BEGIN
  -- First check for regular Supabase auth
  IF auth.uid() IS NOT NULL THEN
    RETURN auth.uid();
  END IF;
  
  -- Fallback: Check for Lightning pubkey
  v_pubkey := current_setting('app.current_pubkey', true);
  IF v_pubkey IS NOT NULL AND v_pubkey != '' THEN
    SELECT id INTO v_user_id FROM public.users WHERE lightning_pubkey = v_pubkey;
    RETURN v_user_id;
  END IF;
  
  RETURN NULL;
END;
$$;
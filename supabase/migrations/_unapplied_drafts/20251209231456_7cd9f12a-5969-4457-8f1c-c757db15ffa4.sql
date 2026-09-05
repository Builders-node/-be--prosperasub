-- Create a security definer function to get or create Solana users
-- This bypasses RLS to allow Solana users to authenticate properly
CREATE OR REPLACE FUNCTION public.get_or_create_solana_user(p_wallet_address text)
RETURNS TABLE(
  id uuid,
  email text,
  display_name text,
  avatar_url text,
  auth_provider text,
  created_at timestamp with time zone,
  last_login_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_email text;
BEGIN
  v_email := p_wallet_address || '@solana.wallet';
  
  -- Try to find existing user
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.email = v_email;
  
  -- If not found, create new user
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (email, auth_provider, display_name)
    VALUES (v_email, 'solana', 'Solana User')
    RETURNING public.users.id INTO v_user_id;
  ELSE
    -- Update last login
    UPDATE public.users
    SET last_login_at = now()
    WHERE public.users.id = v_user_id;
  END IF;
  
  -- Return user data
  RETURN QUERY
  SELECT 
    u.id,
    u.email,
    u.display_name,
    u.avatar_url,
    u.auth_provider,
    u.created_at,
    u.last_login_at
  FROM public.users u
  WHERE u.id = v_user_id;
END;
$$;

-- Also create a function to update Solana user email
CREATE OR REPLACE FUNCTION public.update_solana_user_email(p_wallet_address text, p_new_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_current_email text;
BEGIN
  v_current_email := p_wallet_address || '@solana.wallet';
  
  -- Find user by wallet email
  SELECT id INTO v_user_id
  FROM public.users
  WHERE email = v_current_email;
  
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- Update the email
  UPDATE public.users
  SET email = p_new_email
  WHERE id = v_user_id;
  
  RETURN true;
END;
$$;
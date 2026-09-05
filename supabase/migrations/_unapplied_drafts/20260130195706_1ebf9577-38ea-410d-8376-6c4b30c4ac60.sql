-- Update get_current_user_id() to prioritize auth.uid() over lightning session
-- This ensures Supabase Auth users are recognized first, with fallback to Lightning

CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_pubkey TEXT;
BEGIN
  -- First priority: Supabase Auth (Google, email/password)
  IF auth.uid() IS NOT NULL THEN
    RETURN auth.uid();
  END IF;
  
  -- Second priority: Lightning session via app.current_pubkey
  v_pubkey := current_setting('app.current_pubkey', true);
  
  IF v_pubkey IS NOT NULL AND v_pubkey != '' THEN
    SELECT id INTO v_user_id
    FROM public.users
    WHERE lightning_pubkey = v_pubkey;
    
    IF v_user_id IS NOT NULL THEN
      RETURN v_user_id;
    END IF;
  END IF;
  
  -- No authenticated user found
  RETURN NULL;
END;
$$;

-- Update handle_new_auth_user to ensure proper sync including auth_provider
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Insert into public.users with id matching auth.uid()
  INSERT INTO public.users (id, email, name, auth_provider)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NEW.email),
    COALESCE(NEW.raw_app_meta_data->>'provider', 'email')
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = COALESCE(EXCLUDED.name, users.name),
    auth_provider = COALESCE(EXCLUDED.auth_provider, users.auth_provider);
  
  -- Auto-assign super_admin role for specific email
  IF NEW.email = 'frorex.studio@gmail.com' THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create a helper function to get user from public.users by auth.uid() or pubkey
CREATE OR REPLACE FUNCTION public.get_current_user_data()
RETURNS TABLE(
  id uuid,
  email text,
  name text,
  display_name text,
  lightning_pubkey text,
  restaurant_id uuid,
  auth_provider text,
  avatar_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    u.id,
    u.email,
    u.name,
    u.display_name,
    u.lightning_pubkey,
    u.restaurant_id,
    u.auth_provider,
    u.avatar_url
  FROM public.users u
  WHERE u.id = v_user_id;
END;
$$;
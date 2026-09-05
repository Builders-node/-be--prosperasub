-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260528214949 · create_auth_rpc_functions

-- ────────────────────────────────────────────────────────────────
-- Auth RPC functions — callable via Supabase REST API (HTTPS)
-- These run SECURITY DEFINER so anon role can execute them safely.
-- Passwords are hashed with pgcrypto (bcrypt $2a$10$) inside PG.
-- ────────────────────────────────────────────────────────────────

-- 1. Login: verify email + password, return user JSON (no hash exposed)
CREATE OR REPLACE FUNCTION public.auth_login_verify(
  p_email    TEXT,
  p_password TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user   RECORD;
  v_roles  TEXT[];
BEGIN
  SELECT u.id, u.email, u.name, u.display_name,
         u.auth_provider, u.avatar_url, u.lightning_pubkey,
         u.password_hash
  INTO   v_user
  FROM   public.users u
  WHERE  u.email = p_email
  LIMIT  1;

  -- unknown user or OAuth-only (no password)
  IF NOT FOUND OR v_user.password_hash IS NULL THEN
    RETURN NULL;
  END IF;

  -- verify using pgcrypto bcrypt (constant-time comparison)
  IF crypt(p_password, v_user.password_hash) != v_user.password_hash THEN
    RETURN NULL;
  END IF;

  -- bump last_login_at
  UPDATE public.users SET last_login_at = NOW() WHERE id = v_user.id;

  -- gather roles
  SELECT COALESCE(array_agg(ur.role::text) FILTER (WHERE ur.role IS NOT NULL), ARRAY[]::text[])
  INTO   v_roles
  FROM   public.user_roles ur
  WHERE  ur.user_id = v_user.id;

  RETURN json_build_object(
    'id',             v_user.id,
    'email',          v_user.email,
    'name',           v_user.name,
    'display_name',   v_user.display_name,
    'auth_provider',  v_user.auth_provider,
    'avatar_url',     v_user.avatar_url,
    'lightning_pubkey', v_user.lightning_pubkey,
    'roles',          v_roles
  );
END;
$$;

-- 2. Sign-up: create a new user (hashes password with pgcrypto)
CREATE OR REPLACE FUNCTION public.auth_signup_user(
  p_email    TEXT,
  p_name     TEXT,
  p_password TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_existing RECORD;
  v_new_id   UUID;
  v_hash     TEXT;
  v_roles    TEXT[];
BEGIN
  v_hash := crypt(p_password, gen_salt('bf', 10));

  SELECT id, password_hash, auth_provider
  INTO   v_existing
  FROM   public.users
  WHERE  email = p_email
  LIMIT  1;

  IF FOUND THEN
    IF v_existing.password_hash IS NOT NULL THEN
      RAISE EXCEPTION 'CONFLICT: account already exists';
    END IF;
    -- OAuth account — add a password
    UPDATE public.users
    SET    password_hash = v_hash,
           name         = COALESCE(NULLIF(p_name,''), name, p_email),
           display_name = COALESCE(NULLIF(p_name,''), display_name, p_email),
           last_login_at = NOW()
    WHERE  id = v_existing.id;

    SELECT COALESCE(array_agg(ur.role::text), ARRAY['user']::text[])
    INTO   v_roles
    FROM   public.user_roles ur
    WHERE  ur.user_id = v_existing.id;

    RETURN json_build_object(
      'id',            v_existing.id,
      'email',         p_email,
      'name',          COALESCE(NULLIF(p_name,''), p_email),
      'display_name',  COALESCE(NULLIF(p_name,''), p_email),
      'auth_provider', 'email',
      'avatar_url',    NULL,
      'lightning_pubkey', NULL,
      'roles',         v_roles
    );
  END IF;

  -- brand-new user
  INSERT INTO public.users (email, name, display_name, password_hash, auth_provider, last_login_at)
  VALUES (p_email, COALESCE(NULLIF(p_name,''), p_email), COALESCE(NULLIF(p_name,''), p_email),
          v_hash, 'email', NOW())
  RETURNING id INTO v_new_id;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_new_id, 'user')
  ON CONFLICT DO NOTHING;

  RETURN json_build_object(
    'id',            v_new_id,
    'email',         p_email,
    'name',          COALESCE(NULLIF(p_name,''), p_email),
    'display_name',  COALESCE(NULLIF(p_name,''), p_email),
    'auth_provider', 'email',
    'avatar_url',    NULL,
    'lightning_pubkey', NULL,
    'roles',         ARRAY['user']::text[]
  );
END;
$$;

-- 3. Check if an email has an account (for password-reset flow)
CREATE OR REPLACE FUNCTION public.auth_check_email(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE email = p_email);
$$;

-- 4. Update password (called after reset-token validation in Node.js)
CREATE OR REPLACE FUNCTION public.auth_update_password(
  p_email    TEXT,
  p_password TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  UPDATE public.users
  SET    password_hash = crypt(p_password, gen_salt('bf', 10))
  WHERE  email = p_email;
  RETURN FOUND;
END;
$$;

-- 5. Upsert OAuth user (Google login)
CREATE OR REPLACE FUNCTION public.auth_upsert_oauth_user(
  p_email        TEXT,
  p_name         TEXT,
  p_display_name TEXT,
  p_provider     TEXT,
  p_avatar_url   TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id    UUID;
  v_roles TEXT[];
BEGIN
  INSERT INTO public.users (email, name, display_name, auth_provider, avatar_url, last_login_at)
  VALUES (p_email, p_name, p_display_name, p_provider, p_avatar_url, NOW())
  ON CONFLICT (email) DO UPDATE
    SET display_name  = EXCLUDED.display_name,
        avatar_url    = EXCLUDED.avatar_url,
        last_login_at = NOW()
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.users WHERE email = p_email;
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_id, 'user') ON CONFLICT DO NOTHING;

  SELECT COALESCE(array_agg(ur.role::text), ARRAY['user']::text[])
  INTO   v_roles
  FROM   public.user_roles ur WHERE ur.user_id = v_id;

  RETURN json_build_object(
    'id',            v_id,
    'email',         p_email,
    'name',          p_name,
    'display_name',  p_display_name,
    'auth_provider', p_provider,
    'avatar_url',    p_avatar_url,
    'roles',         v_roles
  );
END;
$$;

-- 6. Admin: list all users (backend-only, anon key used server-side)
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(json_agg(row_order), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',           u.id,
      'email',        u.email,
      'name',         u.name,
      'display_name', u.display_name,
      'auth_provider',u.auth_provider,
      'avatar_url',   u.avatar_url,
      'created_at',   u.created_at,
      'last_login_at',u.last_login_at,
      'roles', COALESCE(
        (SELECT array_agg(ur.role::text) FROM public.user_roles ur WHERE ur.user_id = u.id),
        ARRAY['user']::text[]
      )
    ) AS row_order
    FROM public.users u
    ORDER BY u.created_at DESC
  ) sub;
$$;

-- Grant execution to anon role (calls are server-side only; HTTPS-encrypted)
GRANT EXECUTE ON FUNCTION public.auth_login_verify(TEXT, TEXT)     TO anon;
GRANT EXECUTE ON FUNCTION public.auth_signup_user(TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.auth_check_email(TEXT)            TO anon;
GRANT EXECUTE ON FUNCTION public.auth_update_password(TEXT, TEXT)  TO anon;
GRANT EXECUTE ON FUNCTION public.auth_upsert_oauth_user(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users()                TO anon;

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260528210328 · initial_auth_schema


-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('super_admin', 'restaurant_admin', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  email          text        UNIQUE,
  password_hash  text,
  name           text,
  display_name   text,
  auth_provider  text        DEFAULT 'email',
  avatar_url     text,
  lightning_pubkey text      UNIQUE,
  nwc_connection_string text,
  created_at     timestamptz DEFAULT now() NOT NULL,
  last_login_at  timestamptz,
  updated_at     timestamptz DEFAULT now()
);

-- ── User roles ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_roles (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role       public.app_role NOT NULL DEFAULT 'user',
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, role)
);

CREATE INDEX IF NOT EXISTS user_roles_user_id_idx ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON public.user_roles(role);

-- ── Lightning auth sessions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lightning_auth_sessions (
  id         uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  k1         text    NOT NULL UNIQUE,
  status     text    DEFAULT 'pending' NOT NULL,
  pubkey     text,
  created_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz DEFAULT (now() + '00:05:00'::interval) NOT NULL
);

-- ── Helper: has_role ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Allow service role (backend) full access
CREATE POLICY "Service role full access to users"
  ON public.users FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to user_roles"
  ON public.user_roles FOR ALL USING (true) WITH CHECK (true);

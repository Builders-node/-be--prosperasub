ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS banned_until timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS users_deleted_at_idx ON public.users(deleted_at);
CREATE INDEX IF NOT EXISTS users_banned_until_idx ON public.users(banned_until);

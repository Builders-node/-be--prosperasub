-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260619204134 · access_verification_logs

CREATE TABLE IF NOT EXISTS public.access_verification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text,
  user_id uuid,
  result text NOT NULL,
  reason text,
  subscription_count integer NOT NULL DEFAULT 0,
  allowed boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_verification_logs_user_id ON public.access_verification_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_access_verification_logs_created_at ON public.access_verification_logs(created_at DESC);

-- RLS on: writes/reads happen from the backend with the service-role key (bypasses RLS).
-- No public policy => the anon/authenticated roles cannot read this audit trail.
ALTER TABLE public.access_verification_logs ENABLE ROW LEVEL SECURITY;

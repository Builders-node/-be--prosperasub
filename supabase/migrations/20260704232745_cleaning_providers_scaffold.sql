-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704232745 · cleaning_providers_scaffold


-- Bring cleaning under the same provider model as food/cars/massage. The
-- platform-run cleaning service becomes a single "ProsperaSub Cleaning"
-- provider (admin_user_id NULL — no owner user, super_admin manages it), so
-- the same shells (BecomeProvider, ProviderApplications, useMyProviders,
-- ProviderPortalShell, admin CRUD) work for cleaning without special cases.

CREATE TABLE IF NOT EXISTS public.cleaning_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  avatar_url text,
  banner_url text,
  location text,
  working_hours text,
  status text NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 0,
  admin_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cleaning_provider_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.cleaning_providers(id) ON DELETE CASCADE,
  user_id uuid,
  user_email text,
  role text NOT NULL DEFAULT 'manager',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cpm_provider ON public.cleaning_provider_managers (provider_id);
CREATE INDEX IF NOT EXISTS idx_cpm_user     ON public.cleaning_provider_managers (user_id);

ALTER TABLE public.cleaning_providers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_provider_managers  ENABLE ROW LEVEL SECURITY;
CREATE POLICY all_cleaning_providers         ON public.cleaning_providers         FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_cleaning_provider_managers ON public.cleaning_provider_managers FOR ALL TO public USING (true) WITH CHECK (true);

-- Default platform-owned provider. Idempotent — only inserts when there is
-- no provider yet, so re-runs of the migration don't duplicate it.
INSERT INTO public.cleaning_providers (name, description, status)
SELECT 'ProsperaSub Cleaning', 'Platform-run cleaning service', 'active'
WHERE NOT EXISTS (SELECT 1 FROM public.cleaning_providers);

-- Link packages + subscriptions to the default provider.
ALTER TABLE public.cleaning_packages       ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES public.cleaning_providers(id);
ALTER TABLE public.cleaning_subscriptions  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES public.cleaning_providers(id);

UPDATE public.cleaning_packages
   SET provider_id = (SELECT id FROM public.cleaning_providers ORDER BY created_at ASC LIMIT 1)
 WHERE provider_id IS NULL;

UPDATE public.cleaning_subscriptions
   SET provider_id = (SELECT id FROM public.cleaning_providers ORDER BY created_at ASC LIMIT 1)
 WHERE provider_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_cleaning_packages_provider      ON public.cleaning_packages       (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cleaning_subscriptions_provider ON public.cleaning_subscriptions  (provider_id) WHERE provider_id IS NOT NULL;

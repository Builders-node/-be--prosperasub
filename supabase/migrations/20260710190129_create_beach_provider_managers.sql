-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260710190129 · create_beach_provider_managers

CREATE TABLE IF NOT EXISTS public.beach_provider_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL,
  user_id uuid NOT NULL,
  user_email text,
  role text DEFAULT 'manager',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.beach_provider_managers IS
  'Managers granted access to the (platform-owned) Beach Club provider. Same '
  'shape as cleaning_provider_managers; used by UniversalStaffTab.';

ALTER TABLE public.beach_provider_managers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS beach_provider_managers_all ON public.beach_provider_managers;
CREATE POLICY beach_provider_managers_all
  ON public.beach_provider_managers
  FOR ALL TO public
  USING (true) WITH CHECK (true);

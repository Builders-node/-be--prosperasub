-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260903180426 · service_archetypes_family

-- The top level of the browse hierarchy: family → service → category. A
-- visitor's first question is "what KINDS of thing are here", and the home
-- page answers it with family tabs (Experiences | Transport today). A family
-- is data like everything else about an archetype — a third one is an UPDATE,
-- not a release.
ALTER TABLE public.service_archetypes
  ADD COLUMN IF NOT EXISTS family text NOT NULL DEFAULT 'experiences';

UPDATE public.service_archetypes SET family = 'transport' WHERE key = 'vehicles';

COMMENT ON COLUMN public.service_archetypes.family IS
  'Top-level browse grouping shown as tabs on Discovery (experiences | transport | …). Default experiences.';

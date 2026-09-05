-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804201555 · drop_inverted_archetype_category_fk

-- Two contradictory models were in the schema at once:
--
--   service_categories.archetype_key → service_archetypes.key    (current:
--       a category belongs to a service — Cleaning has Apartment Cleaning
--       and Car Wash)
--   service_archetypes.category_key  → service_categories.key    (retired:
--       a service belonged to a category, from before categories were
--       reorganised under archetypes)
--
-- They point at each other, so every archetype pins one of its own children
-- alive. All four pinned rows are the hidden placeholder categories nobody
-- wants (Transport, Food, Home Services, Venues) — deleting one raised
-- "violates foreign key constraint service_archetypes_category_key_fkey".
--
-- Drop the retired direction. The column stays: it still carries data and
-- removing it is a separate, wider change. Nothing reads it for behaviour
-- any more (the last consumer, BecomeProvider's service fallback, now uses
-- the archetype's own key).
alter table public.service_archetypes
  drop constraint if exists service_archetypes_category_key_fkey;

comment on column public.service_archetypes.category_key is
  'RETIRED — the inverted "service belongs to a category" model. Categories now belong to a service via service_categories.archetype_key. Kept only so historical rows are not lost; do not read it for behaviour.';

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812065611 · drop_unused_favorites_table

-- `favorites` was never wired up.
--
-- Zero rows, zero references anywhere in frontend/src or backend/src, no
-- foreign keys pointing at it and no view reading it — a shelf put up for a
-- feature that was never built. Its columns even name the shape it was meant
-- for and never grew out of: restaurant_id / plan_id, from when the platform
-- was only the food service.
--
-- Dropped rather than left in place: an empty table with a plausible name is
-- how the next person builds "favourites" against a schema that predates three
-- of the four services.
--
-- If favourites are wanted later, the shape to build is a polymorphic row
-- against providers.id + provider_plans.id — the ids everything else on the
-- marketplace uses now.

drop table if exists public.favorites;

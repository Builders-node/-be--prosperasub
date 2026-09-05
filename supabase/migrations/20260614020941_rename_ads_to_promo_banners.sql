-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260614020941 · rename_ads_to_promo_banners

-- "ads" as a REST path is blocked by ad blockers (uBlock, Brave Shields).
-- Rename to a neutral name so write requests aren't blocked client-side.
alter table public.ads rename to promo_banners;
alter index if exists ads_placement_active_idx rename to promo_banners_placement_active_idx;

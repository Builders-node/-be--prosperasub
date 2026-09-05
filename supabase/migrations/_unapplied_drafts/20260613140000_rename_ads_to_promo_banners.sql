-- "ads" as a REST path (/rest/v1/ads) is blocked by ad blockers (uBlock,
-- Brave Shields, etc.), causing "Failed to fetch" on writes. Rename to a
-- neutral name so requests aren't blocked client-side.
alter table public.ads rename to promo_banners;
alter index if exists ads_placement_active_idx rename to promo_banners_placement_active_idx;

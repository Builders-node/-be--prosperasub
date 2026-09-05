-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811013418 · drop_old_brand_from_beach_club_description

-- Provider NAMES were aligned earlier, but the description still carried the
-- retired brand: "ProsperaSub Beach Club — memberships and courts". It shows
-- on the provider card in admin and on the workspace header.
--
-- Massage's description mentions "Prospera Village" and is left alone — that is
-- the place the club is in, not the old product name.

update providers
set description = 'Beach Club — memberships and courts',
    updated_at = now()
where id = '00000000-0000-0000-0000-000000beac41'
  and description ilike '%prosperasub%';

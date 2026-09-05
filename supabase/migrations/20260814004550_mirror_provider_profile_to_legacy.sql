-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814004550 · mirror_provider_profile_to_legacy

-- The provider profile is edited in exactly one place now (`providers`), but
-- three legacy readers remain — the food catalog RPC, the food renewal screen,
-- and the owner-hook that still selects from `food_providers`. Until those are
-- retired (Phase 6), mirror the shared columns back so a rename in the
-- workspace cannot leave the storefront showing the old name.
create or replace function mirror_provider_profile_to_legacy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source_provider_id is null then
    return new;
  end if;

  if new.source_service_key = 'food' then
    update food_providers f set
      name          = new.name,
      description   = new.description,
      location      = new.location,
      working_hours = new.working_hours::text,
      contact_phone = new.contact_phone,
      contact_email = new.contact_email,
      avatar_url    = new.avatar_url,
      banner_url    = new.banner_url,
      gallery_urls  = new.gallery_urls,
      delivery_info = new.delivery_info,
      status        = new.status
    where f.id::text = new.source_provider_id::text;

  elsif new.source_service_key = 'cleaning' then
    update cleaning_providers c set
      name          = new.name,
      description   = new.description,
      location      = new.location,
      working_hours = new.working_hours::text,
      contact_phone = new.contact_phone,
      contact_email = new.contact_email,
      avatar_url    = new.avatar_url,
      banner_url    = new.banner_url,
      gallery_urls  = new.gallery_urls,
      status        = new.status
    where c.id::text = new.source_provider_id::text;
  end if;

  return new;
end;
$$;

drop trigger if exists providers_mirror_profile_to_legacy on providers;
create trigger providers_mirror_profile_to_legacy
after update on providers
for each row
execute function mirror_provider_profile_to_legacy();

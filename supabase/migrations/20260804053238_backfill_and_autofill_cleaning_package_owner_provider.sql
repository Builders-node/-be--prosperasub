-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804053238 · backfill_and_autofill_cleaning_package_owner_provider

-- `cleaning_packages` carries BOTH ids: the legacy `provider_id` the public
-- listing groups by, and the universal `owner_provider_id` the provider detail
-- page filters by. Nothing kept them in sync, so a package created with only
-- the legacy id was listed on /services/cleaning but rendered "No plans yet"
-- on its own provider page. "Monthly Car Wash" is in that state today.
--
-- Backfill from the universal mirror row, then keep it filled automatically —
-- same shape as the existing providers_sync_category_from_archetype trigger.

update cleaning_packages p
set    owner_provider_id = u.id
from   providers u
where  p.owner_provider_id is null
  and  p.provider_id is not null
  and  u.source_service_key = 'cleaning'
  and  u.source_provider_id::text = p.provider_id::text;

create or replace function public.cleaning_packages_sync_owner_provider()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_provider_id is null and new.provider_id is not null then
    select u.id into new.owner_provider_id
    from providers u
    where u.source_service_key = 'cleaning'
      and u.source_provider_id::text = new.provider_id::text
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists cleaning_packages_sync_owner_provider on public.cleaning_packages;
create trigger cleaning_packages_sync_owner_provider
  before insert or update of provider_id, owner_provider_id
  on public.cleaning_packages
  for each row
  execute function public.cleaning_packages_sync_owner_provider();

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811164810 · mirror_legacy_provider_images_to_universal

-- A provider can upload an avatar and it never appears anywhere.
--
-- Three of the four Info tabs write to the legacy table — CleaningInfoTab to
-- cleaning_providers, ProviderInfoTab to rental_providers, RestaurantInfoTab
-- to food_providers — while every marketplace surface (the provider rails on
-- ServicePage, the listing cards, ProviderDetail) reads providers.avatar_url.
-- Nothing carried one to the other, so the upload button worked, the file
-- landed in storage, and the picture was never seen. Today no provider has an
-- avatar in either id-space, which is exactly what a silently broken upload
-- looks like.
--
-- A trigger, not a backfill, for the same reason as mirror_plan_to_provider_plans:
-- writes arrive from the browser, the backend and admin tools alike, and the
-- database is the only place that sees all of them.

create or replace function public.mirror_legacy_provider_images()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_source_key text := tg_argv[0];
begin
  -- source_provider_id is uuid, not text; comparing it to new.id::text raises
  -- 42883 and would fail the legacy write itself. A convenience mirror must
  -- never be the reason a provider cannot save their own profile — hence the
  -- exception block below as well.
  update providers p
  set avatar_url = coalesce(new.avatar_url, p.avatar_url),
      banner_url = coalesce(new.banner_url, p.banner_url),
      updated_at = now()
  where p.source_service_key = v_source_key
    and p.source_provider_id = new.id
    and (p.avatar_url is distinct from coalesce(new.avatar_url, p.avatar_url)
      or p.banner_url is distinct from coalesce(new.banner_url, p.banner_url));

  return new;
exception when others then
  raise warning 'mirror_legacy_provider_images(%) failed for %: %', v_source_key, new.id, sqlerrm;
  return new;
end;
$function$;

drop trigger if exists cleaning_providers_mirror_images on cleaning_providers;
create trigger cleaning_providers_mirror_images
  after insert or update of avatar_url, banner_url on cleaning_providers
  for each row execute function public.mirror_legacy_provider_images('cleaning');

drop trigger if exists food_providers_mirror_images on food_providers;
create trigger food_providers_mirror_images
  after insert or update of avatar_url, banner_url on food_providers
  for each row execute function public.mirror_legacy_provider_images('food');

drop trigger if exists rental_providers_mirror_images on rental_providers;
create trigger rental_providers_mirror_images
  after insert or update of avatar_url, banner_url on rental_providers
  for each row execute function public.mirror_legacy_provider_images('rental');

-- Whatever is already there (nothing today) travels across once.
update providers p
set avatar_url = coalesce(l.avatar_url, p.avatar_url),
    banner_url = coalesce(l.banner_url, p.banner_url),
    updated_at = now()
from (
  select id, avatar_url, banner_url, 'cleaning' as k from cleaning_providers
  union all select id, avatar_url, banner_url, 'food'   from food_providers
  union all select id, avatar_url, banner_url, 'rental' from rental_providers
) l
where p.source_provider_id = l.id
  and p.source_service_key = l.k
  and (l.avatar_url is not null or l.banner_url is not null)
  and (p.avatar_url is distinct from coalesce(l.avatar_url, p.avatar_url)
    or p.banner_url is distinct from coalesce(l.banner_url, p.banner_url));

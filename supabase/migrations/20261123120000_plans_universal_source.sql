-- Plans: provider_plans becomes the ONE place a plan is edited.
--
-- Until now a food / cleaning / beach plan lived in its legacy table and was
-- copied into provider_plans by mirror_plan_to_provider_plans(); the offer
-- editor therefore had to know, for every field, which of four tables owned
-- it. From here on the editor writes provider_plans only, and this trigger
-- carries each CHANGED field back to the legacy row for the readers that still
-- use it (checkout price checks, get_food_catalog, the Nest API) until phase 6
-- of docs/DDD_MIGRATION_PLAN.md removes them.
--
-- Loops: a legacy write mirrors forward (depth 1) and must not bounce back; a
-- universal write mirrors back (depth 1) and must not bounce forward. Both
-- functions act only at pg_trigger_depth() = 1.
--
-- Only fields that actually changed are written (OLD vs NEW), so an unrelated
-- update to provider_plans — a reorder, an offer's price sync — can never push
-- a stale value over the legacy row. A failure here FAILS the write: the two
-- copies must not drift, and an editor error is better than a wrong checkout.
--
-- New legacy-backed plans are still created through their legacy table (the
-- orders reference legacy ids); that last fork goes in phase 6.

-- 1. Line the copies up first: where the legacy row is the only one holding a
--    list, provider_plans takes it, so the editor opens on the same values.
update public.provider_plans p
   set features = c.features
  from public.cleaning_packages c
 where p.source_service_key = 'cleaning' and p.source_plan_id = c.id
   and c.features is not null and jsonb_typeof(c.features) = 'array'
   and coalesce(p.features, '[]'::jsonb) is distinct from c.features;

update public.provider_plans p
   set excludes = c.not_included
  from public.cleaning_packages c
 where p.source_service_key = 'cleaning' and p.source_plan_id = c.id
   and c.not_included is not null and jsonb_typeof(c.not_included) = 'array'
   and coalesce(p.excludes, '[]'::jsonb) is distinct from c.not_included;

update public.provider_plans p
   set features = b.amenities
  from public.beach_club_plans b
 where p.source_service_key = 'beach' and p.source_plan_id = b.id::text
   and b.amenities is not null and jsonb_typeof(b.amenities) = 'array'
   and coalesce(p.features, '[]'::jsonb) is distinct from b.amenities;

update public.provider_plans p
   set tags = (select array(select distinct t from unnest(coalesce(p.tags, '{}') || f.dietary_tags) t))
  from public.food_meal_plans f
 where p.source_service_key = 'food' and p.source_plan_id = f.id::text
   and f.dietary_tags is not null and cardinality(f.dietary_tags) > 0;

-- 2. The forward mirror stops bouncing a write that came from provider_plans.
create or replace function public.mirror_plan_to_provider_plans()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_provider   uuid;
  v_svc        text;
  v_name       text;
  v_desc       text;
  v_price      integer;
  v_period     text;
  v_status     text;
  v_sort       integer;
  v_source_id  text;
  v_visibility text := 'public';
begin
  -- A change that provider_plans itself made (mirror_provider_plan_to_legacy)
  -- is already there.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if TG_TABLE_NAME = 'cleaning_packages' then
    v_svc := 'cleaning';
    v_provider := new.owner_provider_id;
    v_name  := new.name;
    v_desc  := new.description;
    v_price := coalesce(new.monthly_price_cents,
                        new.price_per_cleaning_cents * coalesce(new.cleanings_per_month, 1));
    v_period := 'monthly';
    v_status := case when coalesce(new.is_active, true)
                      and coalesce(new.status, 'active') = 'active'
                      and new.deleted_at is null
                     then 'active' else 'inactive' end;
    v_sort := new.sort_order;
    v_source_id := new.id::text;
    v_visibility := case when coalesce(new.visibility, 'public') = 'private'
                         then 'private' else 'public' end;

  elsif TG_TABLE_NAME = 'food_meal_plans' then
    v_svc := 'food';
    select p.id into v_provider from providers p
     where p.source_service_key = 'food' and p.source_provider_id = new.provider_id;
    v_name  := new.name;
    v_desc  := new.description;
    v_price := new.weekly_price_cents;
    v_period := 'weekly';
    v_status := case when coalesce(new.status, 'active') = 'active' then 'active' else 'inactive' end;
    v_sort := new.sort_order;
    v_source_id := new.id::text;

  elsif TG_TABLE_NAME = 'beach_club_plans' then
    v_svc := 'beach';
    v_provider := new.owner_provider_id;
    v_name  := new.name;
    v_desc  := new.tagline;
    v_price := new.price_per_person_cents;
    v_period := 'monthly';
    v_status := case when coalesce(new.is_active, true) then 'active' else 'inactive' end;
    v_sort := new.sort_order;
    v_source_id := new.id::text;
  else
    return new;
  end if;

  if v_provider is null then
    return new;
  end if;

  insert into provider_plans
    (provider_id, name, description, price_cents, currency, period, status, sort_order,
     source_service_key, source_plan_id, visibility, updated_at)
  values
    (v_provider, v_name, v_desc, coalesce(v_price, 0), 'USD', v_period, v_status,
     coalesce(v_sort, 0), v_svc, v_source_id, v_visibility, now())
  on conflict (source_service_key, source_plan_id) do update
    set provider_id = excluded.provider_id,
        name        = excluded.name,
        description = excluded.description,
        price_cents = excluded.price_cents,
        period      = excluded.period,
        status      = excluded.status,
        sort_order  = excluded.sort_order,
        visibility  = excluded.visibility,
        updated_at  = now();

  return new;
exception when others then
  raise warning 'plan mirror failed for %.%: %', TG_TABLE_NAME, new.id, sqlerrm;
  return new;
end;
$function$;

-- 3. The backward mirror: provider_plans → the legacy row, changed fields only.
create or replace function public.mirror_provider_plan_to_legacy()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_per integer;
  v_mode text;
  v_diets text[] := array['keto','vegan','vegetarian','gym','high_protein','low_carb','diabetic',
                          'pescatarian','mediterranean','kids','gluten_free','balanced'];
begin
  -- Only a direct write to provider_plans; a forward mirror is not echoed.
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if new.source_plan_id is null or new.source_service_key is null then
    return new;
  end if;

  if new.source_service_key = 'food' then
    update food_meal_plans f set
      name        = case when new.name is distinct from old.name then new.name else f.name end,
      description = case when new.description is distinct from old.description then new.description else f.description end,
      weekly_price_cents = case when new.price_cents is distinct from old.price_cents then new.price_cents else f.weekly_price_cents end,
      status      = case when new.status is distinct from old.status
                         then (case when new.status = 'active' then 'active' else 'inactive' end) else f.status end,
      sort_order  = case when new.sort_order is distinct from old.sort_order then new.sort_order else f.sort_order end,
      -- features on a food variant is the meal metadata object; only a LIST is highlights.
      highlights  = case when new.features is distinct from old.features and jsonb_typeof(new.features) = 'array'
                         then array(select jsonb_array_elements_text(new.features)) else f.highlights end,
      dietary_tags = case when new.tags is distinct from old.tags
                          then array(select t from unnest(coalesce(new.tags, '{}')) t where t = any(v_diets)) else f.dietary_tags end,
      updated_at  = now()
    where f.id::text = new.source_plan_id;

  elsif new.source_service_key = 'cleaning' then
    select pricing_mode, greatest(1, coalesce(cleanings_per_month, 1)) into v_mode, v_per
      from cleaning_packages where id = new.source_plan_id;
    update cleaning_packages c set
      name        = case when new.name is distinct from old.name then new.name else c.name end,
      description = case when new.description is distinct from old.description then new.description else c.description end,
      monthly_price_cents = case when new.price_cents is distinct from old.price_cents and coalesce(v_mode, '') <> 'price_per_cleaning'
                                 then new.price_cents else c.monthly_price_cents end,
      price_per_cleaning_cents = case when new.price_cents is distinct from old.price_cents and v_mode = 'price_per_cleaning'
                                      then round(new.price_cents::numeric / v_per)::int else c.price_per_cleaning_cents end,
      status      = case when new.status is distinct from old.status
                         then (case when new.status = 'active' then 'active' else 'inactive' end) else c.status end,
      visibility  = case when new.visibility is distinct from old.visibility then new.visibility else c.visibility end,
      sort_order  = case when new.sort_order is distinct from old.sort_order then new.sort_order else c.sort_order end,
      features    = case when new.features is distinct from old.features and jsonb_typeof(new.features) = 'array'
                         then new.features else c.features end,
      not_included = case when new.excludes is distinct from old.excludes then coalesce(new.excludes, '[]'::jsonb) else c.not_included end,
      updated_at  = now()
    where c.id = new.source_plan_id;

  elsif new.source_service_key = 'beach' then
    update beach_club_plans b set
      name        = case when new.name is distinct from old.name then new.name else b.name end,
      tagline     = case when new.description is distinct from old.description then new.description else b.tagline end,
      price_per_person_cents = case when new.price_cents is distinct from old.price_cents then new.price_cents else b.price_per_person_cents end,
      provider_price_per_person_cents = case when new.provider_price_cents is distinct from old.provider_price_cents
                                             then new.provider_price_cents else b.provider_price_per_person_cents end,
      extra_per_person_cents = case when new.markup_cents is distinct from old.markup_cents
                                    then new.markup_cents else b.extra_per_person_cents end,
      is_active   = case when new.status is distinct from old.status then new.status = 'active' else b.is_active end,
      sort_order  = case when new.sort_order is distinct from old.sort_order then new.sort_order else b.sort_order end,
      amenities   = case when new.features is distinct from old.features and jsonb_typeof(new.features) = 'array'
                         then new.features else b.amenities end,
      updated_at  = now()
    where b.id::text = new.source_plan_id;
  end if;

  return new;
end;
$function$;

drop trigger if exists provider_plans_mirror_to_legacy on public.provider_plans;
create trigger provider_plans_mirror_to_legacy
  after update on public.provider_plans
  for each row execute function public.mirror_provider_plan_to_legacy();

-- Trigger functions are not RPC endpoints, but SECURITY DEFINER in public is
-- callable by name unless revoked (see memory: postgrest-definer-functions).
revoke all on function public.mirror_provider_plan_to_legacy() from public, anon, authenticated;

comment on function public.mirror_provider_plan_to_legacy() is
  'provider_plans is the source of truth for plans: each CHANGED field is carried to the legacy food/cleaning/beach row for readers that still use it. Depth-guarded against mirror_plan_to_provider_plans.';

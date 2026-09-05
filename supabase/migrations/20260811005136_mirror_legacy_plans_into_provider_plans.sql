-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811005136 · mirror_legacy_plans_into_provider_plans

-- provider_plans was backfilled once and never maintained, so anything created
-- afterwards never reached it. Today the admin marketplace hub — which counts
-- this table — showed Food 3 plans against 6 real ones and Cleaning 5 against
-- 6; Car Wash's only package was missing entirely. Admins were making decisions
-- from a catalogue that was quietly incomplete.
--
-- Triggers rather than another one-off: writes come from the browser, the
-- backend and admin tools alike, so the database is the only place that sees
-- all of them.

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
begin
  if TG_TABLE_NAME = 'cleaning_packages' then
    v_svc := 'cleaning';
    v_provider := new.owner_provider_id;
    v_name  := new.name;
    v_desc  := new.description;
    -- resolve_monthly price: the plan may be priced per cleaning or per month.
    v_price := coalesce(new.monthly_price_cents,
                        new.price_per_cleaning_cents * coalesce(new.cleanings_per_month, 1));
    v_period := 'monthly';
    -- Four flags decide whether a cleaning package is live; any one of them
    -- being off means it is not on sale.
    v_status := case when coalesce(new.is_active, true)
                      and coalesce(new.status, 'active') = 'active'
                      and new.deleted_at is null
                     then 'active' else 'inactive' end;
    v_sort := new.sort_order;
    v_source_id := new.id::text;

  elsif TG_TABLE_NAME = 'food_meal_plans' then
    v_svc := 'food';
    select p.id into v_provider from providers p
     where p.source_service_key = 'food' and p.source_provider_id = new.provider_id::text;
    v_name  := new.name;
    v_desc  := new.description;
    v_price := new.weekly_price_cents;
    v_period := 'weekly';
    v_status := case when new.status = 'active' then 'active' else 'inactive' end;
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

  -- Without a provider there is nothing to attach the mirror to. Skip rather
  -- than guess — a wrong owner is worse than a missing row.
  if v_provider is null then
    return new;
  end if;

  insert into provider_plans
    (provider_id, name, description, price_cents, currency, period, status, sort_order,
     source_service_key, source_plan_id, updated_at)
  values
    (v_provider, v_name, v_desc, coalesce(v_price, 0), 'USD', v_period, v_status,
     coalesce(v_sort, 0), v_svc, v_source_id, now())
  on conflict (source_service_key, source_plan_id) do update
    set provider_id = excluded.provider_id,
        name        = excluded.name,
        description = excluded.description,
        price_cents = excluded.price_cents,
        period      = excluded.period,
        status      = excluded.status,
        sort_order  = excluded.sort_order,
        updated_at  = now();

  return new;
end;
$function$;

-- The upsert needs something to conflict on.
create unique index if not exists provider_plans_source_uniq
  on provider_plans (source_service_key, source_plan_id)
  where source_service_key is not null and source_plan_id is not null;

drop trigger if exists mirror_cleaning_package on cleaning_packages;
create trigger mirror_cleaning_package
  after insert or update on cleaning_packages
  for each row execute function public.mirror_plan_to_provider_plans();

drop trigger if exists mirror_food_meal_plan on food_meal_plans;
create trigger mirror_food_meal_plan
  after insert or update on food_meal_plans
  for each row execute function public.mirror_plan_to_provider_plans();

drop trigger if exists mirror_beach_club_plan on beach_club_plans;
create trigger mirror_beach_club_plan
  after insert or update on beach_club_plans
  for each row execute function public.mirror_plan_to_provider_plans();

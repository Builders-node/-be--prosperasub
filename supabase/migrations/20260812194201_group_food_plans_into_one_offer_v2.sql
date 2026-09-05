-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812194201 · group_food_plans_into_one_offer_v2

-- Elias Cuisine's six plans become one offer with two axes.
--
-- No name parsing: `days_per_week` and `meals_per_day` are already columns on
-- food_meal_plans, so the grid is read from the data rather than guessed from
-- "Mon-Fri: 2 Times". Every variant keeps its own price and its own
-- source_plan_id, so the checkout, the weekly menus and the live subscriptions
-- all go on pointing at exactly the rows they pointed at before.
--
-- Idempotent: re-running finds the offer by (provider_id, name) and updates.
-- The offer's own price is set by the trigger from its variants.

do $$
declare
  v_provider uuid;
  v_legacy   uuid;
  v_offer    uuid;
  v_days     uuid;
  v_meals    uuid;
  v_count    int;
begin
  select id, source_provider_id::uuid into v_provider, v_legacy
    from public.providers
   where source_service_key = 'food' and status = 'active' limit 1;
  if v_provider is null then raise notice 'no active food provider; nothing to do'; return; end if;

  select id into v_offer from public.provider_plans
   where provider_id = v_provider and name = 'Meal Plan' and parent_plan_id is null;

  if v_offer is null then
    insert into public.provider_plans
      (provider_id, name, description, price_cents, currency, period, status,
       sort_order, source_service_key, features)
    values
      (v_provider, 'Meal Plan',
       'Home-cooked meals delivered on the days you choose. Pick how many days a week and how many meals a day.',
       0, 'USD', 'weekly', 'active', 0, 'food', '[]'::jsonb)
    returning id into v_offer;
  end if;

  insert into public.plan_option_groups (plan_id, key, label, sort_order)
  values (v_offer, 'days', 'Days per week', 0)
  on conflict (plan_id, key) do update set label = excluded.label
  returning id into v_days;

  insert into public.plan_option_groups (plan_id, key, label, sort_order)
  values (v_offer, 'meals_per_day', 'Meals per day', 1)
  on conflict (plan_id, key) do update set label = excluded.label
  returning id into v_meals;

  -- Values come from the plans that actually exist, so an axis never offers a
  -- combination nobody sells.
  insert into public.plan_options (group_id, key, label, sort_order)
  select v_days, f.days_per_week::text,
         case f.days_per_week when 5 then 'Mon–Fri' when 6 then 'Mon–Sat' when 7 then 'Every day'
              else f.days_per_week || ' days' end,
         f.days_per_week
    from public.food_meal_plans f
   where f.status = 'active' and f.provider_id = v_legacy
   group by f.days_per_week
  on conflict (group_id, key) do update set label = excluded.label;

  insert into public.plan_options (group_id, key, label, sort_order)
  select v_meals, f.meals_per_day::text,
         f.meals_per_day || case when f.meals_per_day = 1 then ' meal a day' else ' meals a day' end,
         f.meals_per_day
    from public.food_meal_plans f
   where f.status = 'active' and f.provider_id = v_legacy
   group by f.meals_per_day
  on conflict (group_id, key) do update set label = excluded.label;

  update public.provider_plans pp
     set parent_plan_id = v_offer,
         option_keys = jsonb_build_object('days', f.days_per_week::text,
                                          'meals_per_day', f.meals_per_day::text),
         updated_at = now()
    from public.food_meal_plans f
   where f.id::text = pp.source_plan_id::text
     and pp.source_service_key = 'food'
     and pp.provider_id = v_provider
     and pp.id <> v_offer
     and f.status = 'active';

  get diagnostics v_count = row_count;
  raise notice 'offer % now has % variants', v_offer, v_count;
end $$;

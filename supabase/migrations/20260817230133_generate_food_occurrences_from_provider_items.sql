-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260817230133 · generate_food_occurrences_from_provider_items

-- Deliveries are generated for the meals the PROVIDER has, not for a literal.
--
-- The old body sliced `array['breakfast','lunch','dinner']` by `meals_per_day`,
-- so a restaurant selling brunch generated breakfasts, and one selling a single
-- late dinner generated breakfasts too. The customer's own choice
-- (`selected_meals`) already won where it was set; this fixes the fallback,
-- which is what every subscription written before that picker existed uses.
--
-- Order of preference, unchanged in spirit:
--   1. what the customer picked
--   2. the LAST n of what this provider delivers in a day — the same rule the
--      picker uses, so "2 meals" means the day's later two rather than a
--      hard-coded lunch and dinner
--   3. the three this platform shipped with, for a provider with no dictionary
create or replace function public.generate_food_occurrences(p_days_ahead integer DEFAULT 21)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_created int := 0;
  v_today date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  with subs as (
    select s.id, s.provider_id, s.user_id,
           greatest(s.started_at::date, v_today) as from_day,
           least(s.end_date::date, v_today + p_days_ahead) as to_day,
           coalesce(p.days_per_week, 5) as days_per_week,
           coalesce(
             nullif(s.selected_meals, '{}'),
             -- The provider's own day, last n first — see the comment above.
             (
               select array_agg(x.key order by x.sort_order)
               from (
                 select i.key, i.sort_order
                 from provider_items i
                 join providers pr
                   on pr.id = i.provider_id
                  and pr.source_service_key = 'food'
                  and pr.source_provider_id::text = s.provider_id::text
                 where i.is_active
                 order by i.sort_order desc
                 limit greatest(1, coalesce(p.meals_per_day, 1))
               ) x
             ),
             (array['breakfast','lunch','dinner'])[1:greatest(1, coalesce(p.meals_per_day, 1))]
           ) as meals
      from food_subscriptions s
      left join food_meal_plans p on p.id = s.meal_plan_id
     where s.status = 'active' and s.payment_status = 'paid'
       and s.end_date is not null and s.end_date::date >= v_today
  ),
  slots as (
    select subs.id as sub_id, subs.provider_id, subs.user_id, d::date as day, m as meal
      from subs
      cross join lateral generate_series(subs.from_day, subs.to_day, interval '1 day') d
      cross join lateral unnest(subs.meals) m
     where extract(isodow from d) <= subs.days_per_week
  ),
  ins as (
    insert into service_occurrences
      (provider_id, user_id, item_key, starts_at, status,
       source_service_key, source_subscription_id)
    select pr.id,
           case when s.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then s.user_id::uuid else null end,
           s.meal,
           (s.day::timestamp) at time zone 'America/Tegucigalpa',
           'scheduled', 'food', s.sub_id::text
      from slots s
      join providers pr
        on pr.source_service_key = 'food' and pr.source_provider_id::text = s.provider_id::text
    on conflict do nothing
    returning 1
  )
  select count(*) into v_created from ins;

  return v_created;
end;
$function$;

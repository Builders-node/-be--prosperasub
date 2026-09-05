-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814062140 · unify_c4_generate_food_occurrences

-- Food's scheduled deliveries. They have no legacy equivalent — `food_delivery_logs`
-- only records what already happened — which is exactly why food has never had
-- a reschedule or an assignee: there was no row for a *planned* delivery to
-- move. This generates them.
--
-- Days come from the plan (`days_per_week`: 5 = Mon–Fri, 6 = Mon–Sat), because
-- `delivery_schedule` is null on every subscription in production. Meals come
-- from the subscription's `selected_meals`, falling back to the plan's
-- `meals_per_day` in canonical order for rows written before that field
-- existed — the same fallback the customer's own screen uses.
create or replace function generate_food_occurrences(p_days_ahead int default 21)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created int := 0;
  v_today date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  with subs as (
    select s.id, s.provider_id, s.user_id, s.meal_plan_id,
           greatest(s.started_at::date, v_today) as from_day,
           least(s.end_date::date, v_today + p_days_ahead) as to_day,
           coalesce(p.days_per_week, 5) as days_per_week,
           coalesce(
             nullif(array(select jsonb_array_elements_text(s.selected_meals)), '{}'),
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
$$;

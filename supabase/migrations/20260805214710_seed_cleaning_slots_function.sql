-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260805214710 · seed_cleaning_slots_function

-- Rolling slot grid.
--
-- The grid was seeded once by hand and ran out on 2026-09-30, which is why a
-- 2- and 3-month plan bought in August had nowhere to put its later visits and
-- why /cleaning-slots would answer an October query with an empty list —
-- indistinguishable, to a partner, from "fully booked".
--
-- Shape is taken from what's already published, not invented: Mon–Sat (no
-- Sunday), four visits a day at 08:00, 10:00, 12:00 and 14:00, each 1h45.
-- Capacity comes from global_settings so the provider's own setting keeps
-- working — Saturday has its own value.
--
-- Idempotent: existing (date, start_time, end_time) rows are left completely
-- alone, so re-running never resets a counter or re-opens a slot an admin
-- switched off.
create or replace function public.seed_cleaning_slots(p_days_ahead integer default 180)
returns table (created integer, seeded_from date, seeded_to date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today      date;
  v_until      date;
  v_default    integer;
  v_saturday   integer;
  v_created    integer;
begin
  if p_days_ahead is null or p_days_ahead < 1 or p_days_ahead > 730 then
    raise exception 'p_days_ahead must be between 1 and 730, got %', p_days_ahead;
  end if;

  -- Honduras local, not UTC. At 18:00 HN the server is already on tomorrow,
  -- and seeding "from tomorrow" would leave a hole for the rest of today.
  v_today := (now() at time zone 'America/Tegucigalpa')::date;
  v_until := v_today + p_days_ahead;

  select coalesce((value #>> '{}')::integer, 2) into v_default
  from global_settings where key = 'default_slot_capacity';
  select coalesce((value #>> '{}')::integer, 2) into v_saturday
  from global_settings where key = 'saturday_slot_capacity';
  v_default  := coalesce(v_default, 2);
  v_saturday := coalesce(v_saturday, 2);

  with grid as (
    select d::date as slot_date, t.start_time, t.end_time
    from generate_series(v_today, v_until, interval '1 day') d
    cross join (values
      ('08:00:00', '09:45:00'),
      ('10:00:00', '11:45:00'),
      ('12:00:00', '13:45:00'),
      ('14:00:00', '15:45:00')
    ) as t(start_time, end_time)
    -- 0 = Sunday. Nobody is rostered, so publishing one would be a promise
    -- the cleaners can't keep.
    where extract(dow from d) <> 0
  )
  insert into cleaning_available_slots
    (id, date, start_time, end_time, max_bookings, current_bookings, is_active)
  select
    'owned-cleaning-slot-' || to_char(g.slot_date, 'YYYY-MM-DD') || '-' ||
      replace(substr(g.start_time, 1, 5), ':', ''),
    g.slot_date, g.start_time, g.end_time,
    case when extract(dow from g.slot_date) = 6 then v_saturday else v_default end,
    0, true
  from grid g
  on conflict (date, start_time, end_time) do nothing;

  get diagnostics v_created = row_count;
  return query select v_created, v_today, v_until;
end;
$$;

comment on function public.seed_cleaning_slots(integer) is
  'Idempotently extends the cleaning slot grid to today+N days (Honduras local). Called by the daily /cron/seed-cleaning-slots.';

grant execute on function public.seed_cleaning_slots(integer) to service_role;

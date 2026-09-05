-- Cleaning slots become per-provider.
--
-- Applied to production on 2026-08-10 via the Supabase MCP and recorded here
-- afterwards. The folder's previous entry is from June — several months of
-- schema changes went in directly and were never written down, so a fresh
-- environment cannot be rebuilt from this history. This file at least stops
-- that gap widening.
--
-- WHY
-- cleaning_available_slots had no provider column and seed_cleaning_slots
-- carried the four times as literals:
--   ('08:00','09:45'), ('10:00','11:45'), ('12:00','13:45'), ('14:00','15:45')
-- so every cleaning provider shared one 105-minute schedule. Car Wash is
-- configured sessionDurationMin = 60 and was still offered 8:00–9:45.
-- providers.booking_settings was read by the booking page only as a filter: it
-- could hide a slot outside opening hours, never change its length.

-- ── Schema ─────────────────────────────────────────────────────────────────
alter table cleaning_available_slots
  add column if not exists provider_id uuid references providers(id) on delete cascade;

comment on column cleaning_available_slots.provider_id is
  'Which provider this slot belongs to. NULL = the legacy shared grid, still the fallback for a provider with no slots of its own.';

-- The old uniqueness was (date, start_time, end_time), which stopped two
-- providers ever offering the same hour. NULLs compare as distinct in a plain
-- unique index, so the legacy rows are coalesced to a sentinel instead.
drop index if exists cleaning_available_slots_date_start_end_key;
alter table cleaning_available_slots
  drop constraint if exists cleaning_available_slots_date_start_time_end_time_key;

create unique index if not exists cleaning_available_slots_provider_slot_uniq
  on cleaning_available_slots (
    date, start_time, end_time,
    coalesce(provider_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index if not exists cleaning_available_slots_provider_date_idx
  on cleaning_available_slots (provider_id, date) where is_active;

-- ── Seeder ─────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE with an added parameter makes an OVERLOAD, not a
-- replacement, and the backend cron calls this RPC with p_days_ahead alone —
-- which would then be ambiguous and fail nightly. Drop the old signature.
drop function if exists public.seed_cleaning_slots(integer);

create or replace function public.seed_cleaning_slots(
  p_days_ahead integer default 180,
  p_provider_id uuid default null
)
returns table(created integer, seeded_from date, seeded_to date)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_today    date;
  v_until    date;
  v_default  integer;
  v_saturday integer;
  v_created  integer := 0;
  v_rows     integer;
  r          record;
begin
  if p_days_ahead is null or p_days_ahead < 1 or p_days_ahead > 730 then
    raise exception 'p_days_ahead must be between 1 and 730, got %', p_days_ahead;
  end if;

  -- Honduras local, not UTC. At 18:00 HN the server is already on tomorrow and
  -- seeding "from tomorrow" would leave a hole for the rest of today.
  v_today := (now() at time zone 'America/Tegucigalpa')::date;
  v_until := v_today + p_days_ahead;

  select coalesce((value #>> '{}')::integer, 2) into v_default
  from global_settings where key = 'default_slot_capacity';
  select coalesce((value #>> '{}')::integer, 2) into v_saturday
  from global_settings where key = 'saturday_slot_capacity';
  v_default  := coalesce(v_default, 2);
  v_saturday := coalesce(v_saturday, 2);

  -- The shared grid, unchanged. Still the schedule for any provider without
  -- one of its own; dropping it would strand them with no days published.
  if p_provider_id is null then
    with grid as (
      select d::date as slot_date, t.start_time, t.end_time
      from generate_series(v_today, v_until, interval '1 day') d
      cross join (values
        ('08:00:00', '09:45:00'), ('10:00:00', '11:45:00'),
        ('12:00:00', '13:45:00'), ('14:00:00', '15:45:00')
      ) as t(start_time, end_time)
      where extract(dow from d) <> 0   -- 0 = Sunday, nobody rostered
    )
    insert into cleaning_available_slots
      (id, date, start_time, end_time, max_bookings, current_bookings, is_active, provider_id)
    select
      'owned-cleaning-slot-' || to_char(g.slot_date, 'YYYY-MM-DD') || '-' ||
        replace(substr(g.start_time, 1, 5), ':', ''),
      g.slot_date, g.start_time, g.end_time,
      case when extract(dow from g.slot_date) = 6 then v_saturday else v_default end,
      0, true, null
    from grid g
    on conflict do nothing;

    get diagnostics v_rows = row_count;
    v_created := v_created + v_rows;
  end if;

  -- Per-provider grids. Without an explicit id this only TOPS UP providers
  -- that already have one: moving a provider off the shared rows is deliberate,
  -- because its live bookings and its capacity live there, and doing it
  -- automatically would put the same hour in two grids with two capacities.
  for r in
    select pr.id,
           coalesce((pr.booking_settings->>'sessionDurationMin')::int, 60) as dur,
           coalesce((pr.booking_settings->>'bufferAfterMin')::int, 0)      as buf,
           pr.booking_settings->'weekly'                                   as weekly
    from providers pr
    where pr.archetype_key = 'cleaning'
      and pr.status = 'active'
      and pr.booking_settings ? 'weekly'
      and jsonb_typeof(pr.booking_settings->'weekly') = 'array'
      and (
        pr.id = p_provider_id
        or (p_provider_id is null
            and exists (select 1 from cleaning_available_slots s where s.provider_id = pr.id))
      )
  loop
    -- A non-positive step would loop forever; a bad row is skipped, loudly.
    if r.dur <= 0 or (r.dur + r.buf) <= 0 then
      raise warning 'provider % has a non-positive session duration (% min); skipped', r.id, r.dur;
      continue;
    end if;

    with days as (
      select d::date as slot_date,
             -- weekly is Monday-first; extract(dow) is Sunday-first.
             r.weekly -> (((extract(dow from d)::int + 6) % 7)) as cfg
      from generate_series(v_today, v_until, interval '1 day') d
    ),
    open_days as (
      select slot_date, (cfg->>'from')::time as opens, (cfg->>'to')::time as closes
      from days
      where coalesce((cfg->>'enabled')::boolean, false)
        and cfg->>'from' is not null and cfg->>'to' is not null
    ),
    grid as (
      select o.slot_date,
             (o.opens + (n * (r.dur + r.buf) || ' minutes')::interval)::time as start_time,
             (o.opens + (n * (r.dur + r.buf) || ' minutes')::interval
                      + (r.dur || ' minutes')::interval)::time               as end_time
      from open_days o
      cross join generate_series(0, 96) as n
    )
    insert into cleaning_available_slots
      (id, date, start_time, end_time, max_bookings, current_bookings, is_active, provider_id)
    select
      'slot-' || substr(replace(r.id::text, '-', ''), 1, 8) || '-'
        || to_char(g.slot_date, 'YYYY-MM-DD') || '-'
        || replace(to_char(g.start_time, 'HH24:MI'), ':', ''),
      g.slot_date, g.start_time, g.end_time,
      case when extract(dow from g.slot_date) = 6 then v_saturday else v_default end,
      0, true, r.id
    from grid g
    join open_days o on o.slot_date = g.slot_date
    where g.end_time <= o.closes and g.start_time >= o.opens
      and g.end_time > g.start_time
    on conflict do nothing;

    get diagnostics v_rows = row_count;
    v_created := v_created + v_rows;
  end loop;

  return query select v_created, v_today, v_until;
end;
$function$;

-- Was callable with the anon key once; keep it shut.
revoke all on function public.seed_cleaning_slots(integer, uuid) from public, anon, authenticated;

-- ── One-off data migration ─────────────────────────────────────────────────
-- Every future booking moves onto a slot belonging to ITS provider at exactly
-- the same date and time. Nobody's appointment changes — moving a customer to a
-- "nearest" slot would be rescheduling them without asking.
--
-- Times with no equivalent in a provider's generated grid (the stray
-- 09:00–11:00, the 14:00–15:45 outside Apartment Cleaning's 14:00 close, and
-- Car Wash's five 105-minute bookings from before it had a grid) get a
-- provider-scoped row with is_active = false: the commitment is honoured and
-- counted against that provider, and the time is never offered again.
-- Reschedule already refuses an inactive slot.
--
-- Past bookings stay put; their rows still exist and history should record
-- what actually happened.

insert into cleaning_available_slots
  (id, date, start_time, end_time, max_bookings, current_bookings, is_active, provider_id)
select distinct
  'legacy-' || substr(replace(pr.id::text, '-', ''), 1, 8) || '-'
    || to_char(s.date, 'YYYY-MM-DD') || '-'
    || replace(to_char(s.start_time::time, 'HH24:MI'), ':', ''),
  s.date, s.start_time, s.end_time, s.max_bookings, 0, false, pr.id
from cleaning_bookings b
join cleaning_available_slots s on s.id = b.slot_id
join cleaning_subscriptions cs on cs.id = b.subscription_id
join cleaning_packages pk on pk.id = cs.package_id
join providers pr on pr.source_provider_id = pk.provider_id and pr.source_service_key = 'cleaning'
where s.date >= (now() at time zone 'America/Tegucigalpa')::date
  and b.status not in ('cancelled', 'completed')
  and s.provider_id is null
  and not exists (
    select 1 from cleaning_available_slots t
    where t.provider_id = pr.id and t.date = s.date
      and t.start_time = s.start_time and t.end_time = s.end_time
  )
on conflict do nothing;

update cleaning_bookings b
set slot_id = t.id, updated_at = now()
from cleaning_available_slots s, cleaning_subscriptions cs, cleaning_packages pk,
     providers pr, cleaning_available_slots t
where s.id = b.slot_id
  and cs.id = b.subscription_id and pk.id = cs.package_id
  and pr.source_provider_id = pk.provider_id and pr.source_service_key = 'cleaning'
  and t.provider_id = pr.id
  and t.date = s.date and t.start_time = s.start_time and t.end_time = s.end_time
  and s.date >= (now() at time zone 'America/Tegucigalpa')::date
  and b.status not in ('cancelled', 'completed')
  and s.provider_id is null;

-- The counters have drifted before and a move like this would drift them again.
update cleaning_available_slots s
set current_bookings = coalesce(c.n, 0), updated_at = now()
from (
  select s2.id, count(b.id) filter (where b.status not in ('cancelled','completed')) as n
  from cleaning_available_slots s2
  left join cleaning_bookings b on b.slot_id = s2.id
  group by s2.id
) c
where c.id = s.id and s.current_bookings is distinct from coalesce(c.n, 0);

-- The 09:00–11:00 rows are 120 minutes and match no step of any generated
-- grid — inserted by hand at some point and sitting in the shared grid ever
-- since, which is why the Car Wash calendar showed a two-hour slot beside its
-- one-hour ones. Deactivated, not deleted: a row a past booking still points
-- at must survive.
update cleaning_available_slots
set is_active = false, updated_at = now()
where provider_id is null
  and start_time = '09:00:00' and end_time = '11:00:00'
  and date >= (now() at time zone 'America/Tegucigalpa')::date
  and is_active
  and not exists (
    select 1 from cleaning_bookings b
    where b.slot_id = cleaning_available_slots.id
      and b.status not in ('cancelled', 'completed')
  );

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810235920 · migrate_future_bookings_to_provider_slots

-- Every future booking moves to a slot belonging to ITS provider, at exactly
-- the same date and time. Nobody's appointment changes — moving a customer to
-- a "nearest" slot would be rescheduling them without asking.
--
-- Times that no longer exist in a provider's generated grid — the stray
-- 09:00–11:00, the 14:00–15:45 that falls outside Apartment Cleaning's 14:00
-- close, and Car Wash's five 105-minute bookings from before it had a grid —
-- get a provider-scoped row created for them with is_active = false. The
-- commitment is honoured and counted against that provider, and the time is
-- never offered to anyone new. Reschedule already refuses an inactive slot.
--
-- Past bookings stay where they are: their slot rows still exist and history
-- should record what actually happened.

-- 1. Make sure every future booking's (provider, date, time) has a slot row.
insert into cleaning_available_slots
  (id, date, start_time, end_time, max_bookings, current_bookings, is_active, provider_id)
select distinct
  'legacy-' || substr(replace(pr.id::text, '-', ''), 1, 8) || '-'
    || to_char(s.date, 'YYYY-MM-DD') || '-'
    || replace(to_char(s.start_time::time, 'HH24:MI'), ':', ''),
  s.date, s.start_time, s.end_time,
  s.max_bookings, 0,
  false,                    -- honoured, not re-offered
  pr.id
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

-- 2. Repoint the bookings.
update cleaning_bookings b
set slot_id = t.id,
    updated_at = now()
from cleaning_available_slots s,
     cleaning_subscriptions cs,
     cleaning_packages pk,
     providers pr,
     cleaning_available_slots t
where s.id = b.slot_id
  and cs.id = b.subscription_id
  and pk.id = cs.package_id
  and pr.source_provider_id = pk.provider_id and pr.source_service_key = 'cleaning'
  and t.provider_id = pr.id
  and t.date = s.date and t.start_time = s.start_time and t.end_time = s.end_time
  and s.date >= (now() at time zone 'America/Tegucigalpa')::date
  and b.status not in ('cancelled', 'completed')
  and s.provider_id is null;

-- 3. Recount every slot from the bookings that actually reference it. The
--    counters drifted before and would drift again after a move like this.
update cleaning_available_slots s
set current_bookings = coalesce(c.n, 0),
    updated_at = now()
from (
  select s2.id, count(b.id) filter (where b.status not in ('cancelled','completed')) as n
  from cleaning_available_slots s2
  left join cleaning_bookings b on b.slot_id = s2.id
  group by s2.id
) c
where c.id = s.id and s.current_bookings is distinct from coalesce(c.n, 0);

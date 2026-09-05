-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811164521 · cleaning_manual_booking_to_provider_slot

-- One booking was left behind by 20260810220000_cleaning_slots_per_provider.
--
-- That migration moved future bookings onto their own provider's grid by
-- walking booking → subscription → package → provider. This one is
-- source = 'admin_manual': an admin added the visit by hand, so it has no
-- subscription, the walk found nothing, and it stayed on the shared 105-minute
-- grid. It does carry cleaning_bookings.provider_id — the LEGACY
-- cleaning_providers id — which is the route this migration takes instead.
--
-- Its provider (Apartment Cleaning) already publishes exactly 2026-08-11
-- 10:00–11:45 in its own grid, so this is a pure re-pointing: same day, same
-- time, same cleaner. Nobody's appointment moves.
--
-- The code path that produced it is fixed alongside this: ensureCleaningSlot()
-- looked slots up by date and time alone, which since grids became
-- per-provider could match another provider's hour entirely.

update cleaning_bookings b
set slot_id = t.id, updated_at = now()
from cleaning_available_slots s,
     cleaning_providers cp,
     providers pr,
     cleaning_available_slots t
where s.id = b.slot_id
  and s.provider_id is null
  and cp.id = b.provider_id
  and pr.source_provider_id = cp.id
  and pr.source_service_key = 'cleaning'
  and t.provider_id = pr.id
  and t.date = s.date
  and t.start_time = s.start_time
  and t.end_time = s.end_time
  and b.subscription_id is null
  and b.status not in ('cancelled', 'completed')
  and s.date >= (now() at time zone 'America/Tegucigalpa')::date;

-- Counters drift whenever a booking changes slots; recompute both sides.
update cleaning_available_slots s
set current_bookings = coalesce(c.n, 0), updated_at = now()
from (
  select s2.id, count(b.id) filter (where b.status not in ('cancelled','completed')) as n
  from cleaning_available_slots s2
  left join cleaning_bookings b on b.slot_id = s2.id
  group by s2.id
) c
where c.id = s.id and s.current_bookings is distinct from coalesce(c.n, 0);

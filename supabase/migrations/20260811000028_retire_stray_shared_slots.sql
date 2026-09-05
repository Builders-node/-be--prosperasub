-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811000028 · retire_stray_shared_slots

-- The 09:00–11:00 rows are 120 minutes and match no step of any provider's
-- generated grid — they were inserted by hand at some point and have been
-- sitting in the shared grid ever since, which is why the Car Wash calendar
-- showed a two-hour slot next to its one-hour ones.
--
-- Their three future bookings already moved onto Apartment Cleaning's own
-- (inactive) copies, so switching these off strands nobody. Deactivated rather
-- than deleted: a row still referenced by a past booking must survive, and
-- is_active is what the booking page and Reschedule already respect.

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

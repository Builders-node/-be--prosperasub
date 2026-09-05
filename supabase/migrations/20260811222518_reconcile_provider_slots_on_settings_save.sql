-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811222518 · reconcile_provider_slots_on_settings_save

-- Saving the booking settings republishes the provider's future days so the
-- grid always equals the settings.
--
-- Surgical deletion of only the newly-blocked slots was not enough: the rows
-- the OLD shape had produced survived. A 09:00–10:00 block left 10:00–11:00
-- (correct, generated at the block's end) sitting immediately beside a stale
-- 11:00–12:00 from the previous grid — back to back with none of the 30-minute
-- buffer the provider had asked for.
--
-- So: clear the future days and let the seeder rewrite them. What is NOT
-- cleared is the point:
--   * anything with a booking — a commitment already made,
--   * anything already inactive — someone switched that hour off on purpose,
--     and the unique index (date, start_time, end_time, provider_id) makes the
--     seeder's insert a no-op for it, so the decision survives.
-- Slot ids are deterministic (provider + date + time), so every unchanged hour
-- is rewritten with exactly the id it had.
--
-- Applied to production on 2026-08-11 via the Supabase MCP and recorded here.

create or replace function public.apply_provider_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_raw   integer;
  v_cap   integer;
  v_today date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  -- Only for a provider that already keeps its own grid. Moving one off the
  -- shared rows is a deliberate act, not something a settings save should do.
  if not exists (select 1 from cleaning_available_slots s where s.provider_id = new.id) then
    return new;
  end if;

  -- ── 1. Republish the future ─────────────────────────────────────────────
  delete from cleaning_available_slots s
  where s.provider_id = new.id
    and s.date >= v_today
    and s.is_active
    and not exists (select 1 from cleaning_bookings b where b.slot_id = s.id);

  perform public.seed_cleaning_slots(180, new.id);

  -- ── 2. Capacity onto every future slot ──────────────────────────────────
  -- After the reseed, so it also covers the hours that survived it. Absence is
  -- checked BEFORE clamping: greatest(1, coalesce(x, 0)) is 1, so an earlier
  -- version read "never set" as a capacity of one and halved the schedule of a
  -- provider that had not answered.
  v_raw := nullif(new.booking_settings->>'capacity', '')::int;
  if v_raw is not null and v_raw >= 1 then
    v_cap := v_raw;
    -- Never below what is already booked into that hour. Lowering means "take
    -- no more", not "cancel someone".
    update cleaning_available_slots s
    set max_bookings = greatest(v_cap, coalesce(s.current_bookings, 0)),
        updated_at = now()
    where s.provider_id = new.id
      and s.date >= v_today
      and s.max_bookings is distinct from greatest(v_cap, coalesce(s.current_bookings, 0));
  end if;

  return new;
exception when others then
  -- A convenience trigger must never be the reason a provider cannot save
  -- their own settings. Note that this hides genuine bugs: it swallowed a
  -- text/time comparison error once and the cleanup did nothing at all while
  -- the migration reported success. Verify changes here by reading rows back.
  raise warning 'apply_provider_slot_capacity failed for %: %', new.id, sqlerrm;
  return new;
end;
$function$;

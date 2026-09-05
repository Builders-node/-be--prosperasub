-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811205720 · fix_apply_provider_slot_capacity_absent_value

-- The "capacity is not set, leave the slots alone" branch never ran.
--
-- It clamped before it checked:
--     v_cap := greatest(1, coalesce((new.booking_settings->>'capacity')::int, 0));
--     if v_cap = 0 ...
-- greatest(1, 0) is 1, so an absent value read as a capacity of ONE and
-- rewrote every future slot to a single booking per hour. Clearing the field —
-- or any unrelated edit to booking_settings on a provider that never set it —
-- silently halved the schedule.
--
-- Check for absence first, then clamp.

create or replace function public.apply_provider_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_raw integer;
  v_cap integer;
begin
  v_raw := nullif(new.booking_settings->>'capacity', '')::int;

  -- Not set: this provider has never answered the question, so its slots keep
  -- whatever they were generated with (the global default). Doing anything
  -- else here means an edit to the working hours silently rewrites capacity.
  if v_raw is null or v_raw < 1 then
    return new;
  end if;
  v_cap := v_raw;

  -- Never below what is already booked into that hour. Lowering the number
  -- means "take no more", not "cancel someone" — and a slot showing 3 booked
  -- of 1 would read as corrupt in every capacity check on the platform.
  update cleaning_available_slots s
  set max_bookings = greatest(v_cap, coalesce(s.current_bookings, 0)),
      updated_at = now()
  where s.provider_id = new.id
    and s.date >= (now() at time zone 'America/Tegucigalpa')::date
    and s.max_bookings is distinct from greatest(v_cap, coalesce(s.current_bookings, 0));

  return new;
exception when others then
  raise warning 'apply_provider_slot_capacity failed for %: %', new.id, sqlerrm;
  return new;
end;
$function$;

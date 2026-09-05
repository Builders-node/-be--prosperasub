-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260805194145 · create_decrement_slot_bookings

-- This function has been called by the app and referenced in CLAUDE.md since
-- reschedule shipped, but it was never created. The admin Operations tab calls
-- it through the `supabase` wrapper, whose rpc() returns {data:[],error:null}
-- for any name it doesn't shim — so the call "succeeded", the manual-decrement
-- fallback never ran, and the reschedule still incremented the new slot.
-- Result: every reschedule from that tab burned a seat on the old slot.
--
-- Atomic and floored at zero, so a double-call can't drive the counter
-- negative and two concurrent calls can't lose a decrement.
create or replace function public.decrement_slot_bookings(p_slot_id text)
returns table (id text, current_bookings integer)
language sql
security definer
set search_path = public
as $$
  update cleaning_available_slots
  set current_bookings = greatest(0, coalesce(current_bookings, 0) - 1),
      updated_at = now()
  where cleaning_available_slots.id = p_slot_id
  returning cleaning_available_slots.id, cleaning_available_slots.current_bookings;
$$;

grant execute on function public.decrement_slot_bookings(text) to anon, authenticated, service_role;

comment on function public.decrement_slot_bookings(text) is
  'Free one seat on a cleaning slot. Atomic, floored at 0. Call after cancelling or moving a booking away from the slot.';

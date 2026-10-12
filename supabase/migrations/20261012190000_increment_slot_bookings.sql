-- The counterpart `decrement_slot_bookings` has always had, and the reason the
-- hand-added-booking path could under-count a slot.
--
-- Every writer that takes a seat does it as a read-modify-write from the
-- browser: read current_bookings, add one, write it back. Two admins booking
-- the same hour, or one admin booking a series while the public schedule page
-- books into it, both read the same number and both write the same number — so
-- a slot with two seats taken reports one, and the day's cap stops meaning
-- anything. The decrement side was already atomic; this is the other half.
--
-- SECURITY DEFINER in schema public is anon-callable (PostgREST exposes it at
-- /rest/v1/rpc/), which is correct here and grants nothing new: the browser can
-- already write this column directly through the table's permissive RLS. All
-- this function can do is add one to a counter.
create or replace function public.increment_slot_bookings(p_slot_id text)
returns table(id text, current_bookings integer, max_bookings integer)
language sql
security definer
set search_path to 'public'
as $function$
  update cleaning_available_slots
  set current_bookings = coalesce(current_bookings, 0) + 1,
      updated_at = now()
  where cleaning_available_slots.id = p_slot_id
  returning cleaning_available_slots.id,
            cleaning_available_slots.current_bookings,
            cleaning_available_slots.max_bookings;
$function$;

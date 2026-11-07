-- Car rentals: the browser reads, only the server writes.
--
-- Every rental_* table had one policy, FOR ALL TO public USING (true) WITH
-- CHECK (true): anyone holding the public anon key could mark a booking paid,
-- change its total, or lower a car's price and then book it at that price.
-- Every write now goes through Edge `api` (routes/rentals.ts) with the service
-- role, which bypasses RLS; the browser keeps SELECT.
--
-- APPLY ONLY AFTER the frontend that writes through the API is live (commit
-- "fix(vehicles): rentals are written by the server only") — before that, the
-- old pages' direct writes would start failing.

drop policy if exists rental_bookings_all   on public.rental_bookings;
drop policy if exists rental_vehicles_all   on public.rental_vehicles;
drop policy if exists rental_ins_all        on public.rental_insurance_tiers;
drop policy if exists rental_extras_all     on public.rental_extras;
drop policy if exists rental_zones_all      on public.rental_delivery_zones;
drop policy if exists rental_categories_all on public.rental_categories;

create policy rental_bookings_read   on public.rental_bookings        for select to public using (true);
create policy rental_vehicles_read   on public.rental_vehicles        for select to public using (true);
create policy rental_ins_read        on public.rental_insurance_tiers for select to public using (true);
create policy rental_extras_read     on public.rental_extras          for select to public using (true);
create policy rental_zones_read      on public.rental_delivery_zones  for select to public using (true);
create policy rental_categories_read on public.rental_categories      for select to public using (true);

-- Belt and braces: no write privilege for the browser roles at all.
revoke insert, update, delete on
  public.rental_bookings, public.rental_vehicles, public.rental_insurance_tiers,
  public.rental_extras, public.rental_delivery_zones, public.rental_categories
from anon, authenticated;

-- One payment settles one booking.
create unique index if not exists rental_bookings_paid_reference_uidx
  on public.rental_bookings (payment_reference)
  where payment_status = 'paid' and payment_reference is not null;

-- Car rentals: running the fleet, not just listing it.
--
--   rental_bookings gains the handover and the return — when the car left and
--   came back, the odometer and the fuel (in eighths of a tank) at each end,
--   and the notes / damage seen. That is what settles a dispute about a
--   scratch or an empty tank.
--
--   rental_blocks — days a car cannot be rented (service, repair, the owner
--   using it). Kept OUT of rental_bookings on purpose: a block is not an order,
--   has no customer and no money, and every revenue reader would have to learn
--   to skip it. Booking and blocking each check the other in the Edge api.

alter table public.rental_bookings
  add column if not exists pickup_at timestamptz,
  add column if not exists pickup_odometer_km integer check (pickup_odometer_km is null or pickup_odometer_km >= 0),
  add column if not exists pickup_fuel_eighths smallint check (pickup_fuel_eighths is null or pickup_fuel_eighths between 0 and 8),
  add column if not exists pickup_notes text,
  add column if not exists return_at timestamptz,
  add column if not exists return_odometer_km integer check (return_odometer_km is null or return_odometer_km >= 0),
  add column if not exists return_fuel_eighths smallint check (return_fuel_eighths is null or return_fuel_eighths between 0 and 8),
  add column if not exists return_notes text,
  add column if not exists damage_notes text;

create table if not exists public.rental_blocks (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.rental_vehicles(id) on delete cascade,
  provider_id uuid references public.providers(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text check (reason is null or char_length(reason) <= 200),
  created_by text,
  created_at timestamptz not null default now(),
  constraint rental_blocks_dates check (end_date >= start_date)
);
create index if not exists rental_blocks_vehicle_idx on public.rental_blocks (vehicle_id, start_date);

alter table public.rental_blocks enable row level security;
-- The storefront's calendar greys these days out, so anyone may read them;
-- only the Edge api (service role) writes.
drop policy if exists rental_blocks_read on public.rental_blocks;
create policy rental_blocks_read on public.rental_blocks for select to public using (true);
revoke insert, update, delete on public.rental_blocks from anon, authenticated;

comment on table public.rental_blocks is
  'Days a vehicle cannot be rented (service, repair, own use). Not an order: no customer, no money. The Edge api refuses a booking over a block and a block over a booking.';

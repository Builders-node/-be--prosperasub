-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706010926 · service_archetypes

-- Service archetype: a business-unit template that packages default capabilities,
-- resource type, and operational config for providers of that business type.
-- Categories remain the UI grouping; archetypes are the operational blueprint.
create table if not exists public.service_archetypes (
  key text primary key,
  label text not null,
  description text,
  category_key text references public.service_categories(key),
  icon text default 'Store',
  accent text default 'bg-primary',
  default_capabilities jsonb not null default '[]'::jsonb,
  default_resource_type text references public.resource_types(key),
  default_booking_model text check (default_booking_model in ('time_slot','date_range','capacity_seat')),
  default_booking_settings jsonb,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists service_archetypes_category_idx on public.service_archetypes (category_key);

alter table public.service_archetypes enable row level security;
drop policy if exists all_service_archetypes on public.service_archetypes;
create policy all_service_archetypes on public.service_archetypes for all to public using (true) with check (true);

-- Provider soft-references its archetype (optional; existing providers stay linkless).
alter table public.providers add column if not exists archetype_key text references public.service_archetypes(key);
create index if not exists providers_archetype_idx on public.providers (archetype_key);

-- Seed the initial archetypes derived from the live services + a few future-facing ones.
insert into public.service_archetypes (key, label, description, category_key, icon, accent, default_capabilities, default_resource_type, default_booking_model, sort_order) values
  ('car_rental',         'Car Rental',          'Multi-day vehicle rentals with insurance, extras and delivery.', 'transport', 'Car',            'bg-purple-500',  '["date_range_booking","catalog_items","delivery"]'::jsonb, 'vehicle',    'date_range',    10),
  ('motorcycle_rental',  'Motorcycle Rental',   'Multi-day motorcycle rentals.',                                  'transport', 'Bike',           'bg-purple-500',  '["date_range_booking","catalog_items","delivery"]'::jsonb, 'vehicle',    'date_range',    20),
  ('equipment_rental',   'Equipment Rental',    'Rentals of gear, tools, sports equipment.',                      'transport', 'Wrench',         'bg-purple-500',  '["date_range_booking","catalog_items"]'::jsonb,             'vehicle',    'date_range',    30),
  ('food_subscription',  'Food Subscription',   'Recurring meal plans with weekly menus and delivery.',           'food',      'UtensilsCrossed','bg-orange-500',  '["subscription_plans","catalog_items","delivery"]'::jsonb, null,          null,             40),
  ('food_delivery',      'Food Delivery',       'On-demand ordering from a fixed menu.',                          'food',      'ShoppingBag',    'bg-orange-500',  '["catalog_items","delivery"]'::jsonb,                       null,          null,             50),
  ('cleaning_service',   'Cleaning Service',    'Recurring cleaning subscriptions on scheduled slots.',           'home',      'Sparkles',       'bg-blue-500',    '["subscription_plans","hourly_bookings"]'::jsonb,           null,          'time_slot',      60),
  ('court_booking',      'Court Booking',       'Hourly reservations for tennis, pickleball, and similar courts.','venues',    'CircleDot',      'bg-cyan-500',    '["hourly_bookings"]'::jsonb,                                'tennis',      'time_slot',      70),
  ('beach_membership',   'Beach Club Membership','Per-person recurring memberships with venue access.',           'venues',    'Waves',          'bg-cyan-500',    '["subscription_plans"]'::jsonb,                             null,          null,             80),
  ('wellness_appointment','Wellness Appointment','Session-based bookings with a practitioner (massage, therapy).','wellness',  'HeartPulse',     'bg-rose-500',    '["hourly_bookings","subscription_plans"]'::jsonb,           'appointment', 'time_slot',      90),
  ('coworking',          'Coworking',           'Desk day-passes and hour-based work spaces.',                    'activities','Briefcase',      'bg-amber-500',   '["hourly_bookings","subscription_plans"]'::jsonb,           'desk',        'capacity_seat', 100)
on conflict (key) do nothing;

-- Auto-link existing legacy-backed providers to sensible defaults (best-effort).
update public.providers p set archetype_key = 'car_rental'         where archetype_key is null and source_service_key='cars';
update public.providers p set archetype_key = 'food_subscription'  where archetype_key is null and source_service_key='food';
update public.providers p set archetype_key = 'cleaning_service'   where archetype_key is null and source_service_key='cleaning';
update public.providers p set archetype_key = 'beach_membership'   where archetype_key is null and source_service_key='beach';

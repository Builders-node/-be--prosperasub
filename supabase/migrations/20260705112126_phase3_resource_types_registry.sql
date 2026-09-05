-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705112126 · phase3_resource_types_registry

-- Phase 3: Resource domain — the type registry. Each type declares its
-- booking_model (the strategy the Booking engine uses) + a metadata schema.
-- Adding a new industry = insert a resource_type + resources with metadata.
create table if not exists public.resource_types (
  key text primary key,
  label text not null,
  booking_model text not null check (booking_model in ('time_slot','date_range','capacity_seat')),
  metadata_schema jsonb not null default '{}'::jsonb,
  constraints jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Config table — browser-readable like service_categories (permissive RLS).
alter table public.resource_types enable row level security;
drop policy if exists all_resource_types on public.resource_types;
create policy all_resource_types on public.resource_types for all to public using (true) with check (true);

-- Seed: the 3 existing types (backfilled from bookable_resources) + canonical
-- types ready for new industries — no code needed to onboard them.
insert into public.resource_types (key, label, booking_model, metadata_schema, constraints, sort_order) values
  ('vehicle',     'Vehicle',      'date_range',    '{"make":"string","model":"string","year":"number","seats":"number","transmission":"string"}'::jsonb, '{"min_days":1}'::jsonb,            10),
  ('tennis',      'Tennis court', 'time_slot',     '{"surface":"string"}'::jsonb,                                                                         '{}'::jsonb,                        20),
  ('pickleball',  'Pickleball',   'time_slot',     '{"surface":"string"}'::jsonb,                                                                         '{}'::jsonb,                        30),
  ('room',        'Room',         'date_range',    '{"beds":"number","view":"string"}'::jsonb,                                                            '{"min_days":1}'::jsonb,            40),
  ('table',       'Table',        'time_slot',     '{"seats":"number","area":"string"}'::jsonb,                                                           '{}'::jsonb,                        50),
  ('desk',        'Desk',         'capacity_seat', '{"floor":"string","amenities":"string"}'::jsonb,                                                      '{}'::jsonb,                        60),
  ('appointment', 'Appointment',  'time_slot',     '{"specialty":"string"}'::jsonb,                                                                       '{"requires_staff":true}'::jsonb,  70)
on conflict (key) do nothing;

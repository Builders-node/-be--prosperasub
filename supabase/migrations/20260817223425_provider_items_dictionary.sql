-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260817223425 · provider_items_dictionary

-- What a provider delivers within a day, named by the provider.
--
-- "Breakfast, lunch, dinner" is written into this platform in six places: a TS
-- union, three label maps in three screens, a picker's key list, and a slice of
-- a literal array inside `generate_food_occurrences`. A restaurant that sells
-- brunch, or a second dinner, or a pre-workout meal cannot be described at all,
-- and a kitchen that calls lunch "almuerzo" reads English on its own manifest.
--
-- An item is a row here instead. `service_occurrences.item_key` already holds
-- free text — it carries "Tennis Court 1" for the beach club — so nothing about
-- occurrences changes: this is the dictionary that gives a key its label, its
-- order in the day, and the time it is usually served.
create table if not exists public.provider_items (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  /** What `service_occurrences.item_key` holds. Stable; the label may change. */
  key text not null,
  label text not null,
  /** Order within the day — breakfast before dinner, whatever they are called. */
  sort_order integer not null default 0,
  /** When it is usually served, as minutes from midnight. Null = no fixed time. */
  default_minutes integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, key)
);

comment on table public.provider_items is
  'The things a provider delivers within a day (meals, sessions), named by the provider. Gives service_occurrences.item_key its label and its order. Not an enum — a restaurant may have brunch, a gym may have a morning session.';

alter table public.provider_items enable row level security;

-- Config-table treatment, as everywhere else on this platform: labels are not
-- secret and no authorization decision reads them.
drop policy if exists provider_items_all on public.provider_items;
create policy provider_items_all on public.provider_items for all to public using (true) with check (true);

-- The three that exist today, for the one restaurant that has them.
insert into public.provider_items (provider_id, key, label, sort_order, default_minutes)
select p.id, v.key, v.label, v.sort_order, v.minutes
from public.providers p
cross join (values
  ('breakfast', 'Breakfast', 10, 8 * 60),
  ('lunch',     'Lunch',     20, 12 * 60),
  ('dinner',    'Dinner',    30, 19 * 60)
) as v(key, label, sort_order, minutes)
where p.source_service_key = 'food'
on conflict (provider_id, key) do nothing;

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260813234831 · unify_providers_hours_members_plan_gallery

-- ── 1. Working hours become JSONB ──────────────────────────────────────────
-- The same concept was TEXT on providers and JSONB on bookable_resources, so
-- every reader had to know which one it was holding. One row is populated and
-- it already contains valid JSON, so the cast is lossless.
alter table providers
  alter column working_hours type jsonb
  using case
    when working_hours is null or btrim(working_hours) = '' then null
    else working_hours::jsonb
  end;

-- ── 2. One team table for every provider ───────────────────────────────────
-- Replaces food_restaurant_managers and cleaning_provider_managers, which were
-- the same five columns twice and left a universal provider with nowhere to
-- put a colleague at all.
create table if not exists provider_members (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  user_id text,
  user_email text not null,
  user_name text,
  role text not null default 'manager',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists provider_members_provider_email_key
  on provider_members (provider_id, lower(user_email));
create index if not exists provider_members_provider_idx on provider_members (provider_id);

alter table provider_members enable row level security;
do $$ begin
  create policy provider_members_all on provider_members for all to public using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Backfill through the id bridge: the legacy tables key off the legacy
-- provider id, the universal one off providers.id.
insert into provider_members (provider_id, user_id, user_email, user_name, role)
select p.id, m.user_id::text, m.user_email, m.user_name, 'manager'
from food_restaurant_managers m
join providers p on p.source_service_key = 'food' and p.source_provider_id = m.provider_id
where m.user_email is not null
on conflict do nothing;

insert into provider_members (provider_id, user_id, user_email, user_name, role)
select p.id, m.user_id::text, m.user_email, null, coalesce(m.role, 'manager')
from cleaning_provider_managers m
join providers p on p.source_service_key = 'cleaning' and p.source_provider_id = m.provider_id
where m.user_email is not null
on conflict do nothing;

-- ── 3. A plan carries its own photographs ──────────────────────────────────
-- Until now a plan card borrowed its provider's gallery, so every plan a
-- provider sold looked like every other one.
alter table provider_plans add column if not exists gallery_urls jsonb default '[]'::jsonb;

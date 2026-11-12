-- Home collections: shelves of offers an admin puts together for the home page
-- ("Popular", "For beginners", "For families").
--
-- The home page used to end in one flat list of every plan, which read as
-- whichever business had listed the most things. A collection is a title and
-- an ordered list of provider_plans — a plan may sit on several shelves.
--
-- Anyone may READ an active shelf (the home page is public); writes go only
-- through the Edge api /admin/collections with the service role.

create table if not exists public.home_collections (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 80),
  subtitle text check (subtitle is null or char_length(subtitle) <= 160),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.home_collection_plans (
  collection_id uuid not null references public.home_collections(id) on delete cascade,
  plan_id uuid not null references public.provider_plans(id) on delete cascade,
  sort_order int not null default 0,
  primary key (collection_id, plan_id)
);

create index if not exists home_collection_plans_order_idx
  on public.home_collection_plans (collection_id, sort_order);

alter table public.home_collections enable row level security;
alter table public.home_collection_plans enable row level security;

revoke all on public.home_collections from anon, authenticated;
revoke all on public.home_collection_plans from anon, authenticated;
grant select on public.home_collections to anon, authenticated;
grant select on public.home_collection_plans to anon, authenticated;

drop policy if exists home_collections_read on public.home_collections;
create policy home_collections_read on public.home_collections
  for select to anon, authenticated using (is_active);

drop policy if exists home_collection_plans_read on public.home_collection_plans;
create policy home_collection_plans_read on public.home_collection_plans
  for select to anon, authenticated
  using (exists (select 1 from public.home_collections c where c.id = collection_id and c.is_active));

comment on table public.home_collections is
  'Shelves of offers on the home page, curated by an admin. Public read of active rows; written only through the Edge api /admin/collections.';
comment on table public.home_collection_plans is
  'Which provider_plans sit on a home collection, in order.';

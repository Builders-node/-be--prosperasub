-- The tag dictionary: the words a plan can be tagged with, in groups
-- (Level · Good for · Format · Diet). provider_plans.tags stores the KEYS.
--
-- Tags were free text, so one business's "kids" was the next one's "Kids" and
-- "children" and nothing could filter by them. An admin keeps this list
-- (Admin → Settings → Tags); a business picks from it in the offer editor;
-- the service listing filters by group, search matches the labels, a card
-- shows the first two, and a home collection can be "every plan tagged X".
--
-- Public read; written only through the Edge api /admin/tags (service role).
-- A tag is never deleted — plans hold its key — it is switched off.
-- The frontend carries the same seed (lib/tags.ts) and uses it until this runs.

create table if not exists public.catalog_tag_groups (
  key text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  label text not null check (char_length(label) between 1 and 40),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.catalog_tags (
  key text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  group_key text not null references public.catalog_tag_groups(key) on update cascade,
  label text not null check (char_length(label) between 1 and 40),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.catalog_tag_groups enable row level security;
alter table public.catalog_tags enable row level security;
revoke all on public.catalog_tag_groups from anon, authenticated;
revoke all on public.catalog_tags from anon, authenticated;
grant select on public.catalog_tag_groups to anon, authenticated;
grant select on public.catalog_tags to anon, authenticated;

drop policy if exists catalog_tag_groups_read on public.catalog_tag_groups;
create policy catalog_tag_groups_read on public.catalog_tag_groups for select to anon, authenticated using (true);
drop policy if exists catalog_tags_read on public.catalog_tags;
create policy catalog_tags_read on public.catalog_tags for select to anon, authenticated using (true);

insert into public.catalog_tag_groups (key, label, sort_order) values
  ('level', 'Level', 0), ('audience', 'Good for', 1), ('format', 'Format', 2), ('diet', 'Diet', 3)
on conflict (key) do nothing;

insert into public.catalog_tags (key, group_key, label, sort_order) values
  ('beginner', 'level', 'Beginner', 0), ('advanced', 'level', 'Advanced', 1), ('professional', 'level', 'Professional', 2),
  ('kids', 'audience', 'Kids', 0), ('family', 'audience', 'Family', 1), ('couples', 'audience', 'Couples', 2),
  ('course', 'format', 'Course', 0), ('certification', 'format', 'Certification', 1),
  ('keto', 'diet', 'Keto', 0), ('vegan', 'diet', 'Vegan', 1), ('vegetarian', 'diet', 'Vegetarian', 2),
  ('gym', 'diet', 'Gym', 3), ('high_protein', 'diet', 'High-protein', 4), ('low_carb', 'diet', 'Low-carb', 5),
  ('diabetic', 'diet', 'Diabetic', 6), ('pescatarian', 'diet', 'Pescatarian', 7), ('mediterranean', 'diet', 'Mediterranean', 8),
  ('gluten_free', 'diet', 'Gluten-free', 9), ('balanced', 'diet', 'Balanced', 10)
on conflict (key) do nothing;

-- A home collection can fill itself: every live plan carrying this tag.
alter table public.home_collections add column if not exists tag_key text;

comment on table public.catalog_tags is
  'The words a plan can be tagged with (provider_plans.tags holds the keys). Public read; written through the Edge api /admin/tags. Switched off, never deleted.';
comment on column public.home_collections.tag_key is
  'When set, the shelf is every live plan tagged with this key (in addition to any hand-picked ones, which come first).';

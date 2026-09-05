-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812193945 · plan_options_axes

-- One offer, several variants — instead of one card per combination.
--
-- Elias Cuisine sells one meal plan along two axes (5 or 6 days a week × 1, 2
-- or 3 meals a day) and it reached the customer as six separate cards that
-- differ only in a number. Apartment Cleaning does the same with Studio / 1BR /
-- 2BR. The customer is made to do the combinatorics the provider should have
-- expressed once.
--
-- The axes. `plan_option_groups` is a dimension of one offer ("Meals per day");
-- `plan_options` are the values on it ("2 meals a day"). Both hang off the
-- PARENT plan — the variants themselves carry only which value they picked.
--
-- Prices are NOT derived. Elias charges $8.00, $7.50 and $7.53 a meal across
-- the grid; a base-plus-surcharge model cannot express that without fudging
-- somebody's price, so every combination keeps its own explicit price. That is
-- what makes this a variant model rather than a modifier model.

create table if not exists public.plan_option_groups (
  id         uuid primary key default gen_random_uuid(),
  plan_id    uuid not null references public.provider_plans(id) on delete cascade,
  key        text not null,
  label      text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),
  unique (plan_id, key)
);

create table if not exists public.plan_options (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.plan_option_groups(id) on delete cascade,
  key        text not null,
  label      text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),
  unique (group_id, key)
);

create index if not exists plan_option_groups_plan_idx on public.plan_option_groups (plan_id, sort_order);
create index if not exists plan_options_group_idx      on public.plan_options (group_id, sort_order);

comment on table public.plan_option_groups is
  'A dimension a plan varies along — "Days per week", "Apartment size". Attached to the parent plan; its variants each pick one value per group.';
comment on table public.plan_options is
  'A value on a dimension. `key` is what a variant stores in provider_plans.option_keys; `label` is what the customer reads.';

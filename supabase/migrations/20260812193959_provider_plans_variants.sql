-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812193959 · provider_plans_variants

-- The variant IS the existing plan row.
--
-- provider_plans already mirrors every legacy plan one-to-one (source_plan_id).
-- A separate plan_variants table would have layered a second plan concept on
-- top of that duplication instead of removing it: two price columns, two
-- statuses, two editors, and the six rows still showing up as six plans in the
-- admin list. Making provider_plans self-referential turns those rows into the
-- variants they already were.
--
--   parent_plan_id null  → an offer. What a customer sees as one card.
--   parent_plan_id set   → a variant. Keeps its own price, status and
--                          source_plan_id, so the legacy checkout, the weekly
--                          menus and every subscription go on working untouched.

alter table public.provider_plans
  add column if not exists parent_plan_id uuid references public.provider_plans(id) on delete cascade;

alter table public.provider_plans
  add column if not exists option_keys jsonb;

create index if not exists provider_plans_parent_idx on public.provider_plans (parent_plan_id);

-- Two variants of one offer cannot claim the same combination. jsonb compares
-- by normalised key order, so {"a":"1","b":"2"} and {"b":"2","a":"1"} collide
-- as they should.
create unique index if not exists provider_plans_parent_options_uq
  on public.provider_plans (parent_plan_id, option_keys)
  where parent_plan_id is not null;

comment on column public.provider_plans.parent_plan_id is
  'Set on a variant, pointing at the offer it belongs to. Null on an offer and on a plain standalone plan.';
comment on column public.provider_plans.option_keys is
  'Which value this variant picks on each of the offer''s option groups, e.g. {"days":"5","meals_per_day":"2"}. Null unless parent_plan_id is set.';

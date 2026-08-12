-- Applied to production on 2026-08-12 via the Supabase MCP and recorded here.
--
-- One offer, several variants — instead of one card per combination.
--
-- Elias Cuisine sells one meal plan along two axes (5 or 6 days a week × 1, 2
-- or 3 meals a day) and it reached the customer as six separate cards that
-- differ only in a number. Apartment Cleaning does the same with Studio / 1BR /
-- 2BR. The customer was made to do the combinatorics the provider should have
-- expressed once.
--
-- Prices are NOT derived. Elias charges $8.00, $7.50 and $7.53 a meal across
-- the grid; a base-plus-surcharge model cannot express that without fudging
-- somebody's price, so every combination keeps its own explicit price. That is
-- what makes this a variant model rather than a modifier model.
--
-- The variant IS the existing plan row. provider_plans already mirrors every
-- legacy plan one-to-one (source_plan_id), so a separate plan_variants table
-- would have layered a second plan concept on top of that duplication: two
-- price columns, two statuses, two editors, and the six rows still showing up
-- as six plans. Self-reference turns those rows into the variants they were.

-- ── The axes ────────────────────────────────────────────────────────────────

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

-- Same posture as every other config table here, stated rather than inherited:
-- the admin CRUDs write these from the browser. The money table
-- (provider_payouts) is the deliberate exception.
alter table public.plan_option_groups enable row level security;
alter table public.plan_options       enable row level security;
drop policy if exists plan_option_groups_all on public.plan_option_groups;
create policy plan_option_groups_all on public.plan_option_groups
  for all to public using (true) with check (true);
drop policy if exists plan_options_all on public.plan_options;
create policy plan_options_all on public.plan_options
  for all to public using (true) with check (true);

-- ── The variants ────────────────────────────────────────────────────────────
--   parent_plan_id null  → an offer. What a customer sees as one card.
--   parent_plan_id set   → a variant. Keeps its own price, status and
--                          source_plan_id, so the legacy checkout, the weekly
--                          menus and every subscription go on working untouched.

alter table public.provider_plans
  add column if not exists parent_plan_id uuid references public.provider_plans(id) on delete cascade;
alter table public.provider_plans
  add column if not exists option_keys jsonb;

create index if not exists provider_plans_parent_idx on public.provider_plans (parent_plan_id);

create unique index if not exists provider_plans_parent_options_uq
  on public.provider_plans (parent_plan_id, option_keys)
  where parent_plan_id is not null;

-- One level deep, and an offer may not carry option keys. Unlike the
-- convenience triggers elsewhere in this schema this one does NOT swallow its
-- errors: a bad write here corrupts what a customer is offered and charged.
create or replace function public.provider_plans_check_variant_shape()
returns trigger language plpgsql as $$
declare v_grandparent uuid;
begin
  if new.parent_plan_id is not null then
    if new.parent_plan_id = new.id then
      raise exception 'A plan cannot be a variant of itself.';
    end if;
    select parent_plan_id into v_grandparent
      from public.provider_plans where id = new.parent_plan_id;
    if v_grandparent is not null then
      raise exception 'Plan variants are one level deep; % is already a variant.', new.parent_plan_id;
    end if;
  elsif new.option_keys is not null then
    raise exception 'option_keys belongs on a variant; this plan has no parent.';
  end if;
  return new;
end; $$;

drop trigger if exists provider_plans_variant_shape on public.provider_plans;
create trigger provider_plans_variant_shape
  before insert or update of parent_plan_id, option_keys on public.provider_plans
  for each row execute function public.provider_plans_check_variant_shape();

-- An offer's price is the cheapest way in. price_cents is NOT NULL and every
-- reader expects a number, so an offer cannot have none; a hand-typed one would
-- go stale the first time a variant's price changed. Derived instead.
create or replace function public.provider_plans_sync_offer_price()
returns trigger language plpgsql as $$
declare
  v_parent uuid := coalesce(new.parent_plan_id, old.parent_plan_id);
  v_min    int;
begin
  if v_parent is null then return coalesce(new, old); end if;
  select min(price_cents) into v_min
    from public.provider_plans
   where parent_plan_id = v_parent and status = 'active';
  update public.provider_plans
     set price_cents = coalesce(v_min, 0), updated_at = now()
   where id = v_parent;
  return coalesce(new, old);
end; $$;

drop trigger if exists provider_plans_offer_price on public.provider_plans;
create trigger provider_plans_offer_price
  after insert or update of price_cents, status, parent_plan_id or delete
  on public.provider_plans
  for each row execute function public.provider_plans_sync_offer_price();

comment on column public.provider_plans.parent_plan_id is
  'Set on a variant, pointing at the offer it belongs to. Null on an offer and on a plain standalone plan.';
comment on column public.provider_plans.option_keys is
  'Which value this variant picks on each of the offer''s option groups, e.g. {"days":"5","meals_per_day":"2"}.';

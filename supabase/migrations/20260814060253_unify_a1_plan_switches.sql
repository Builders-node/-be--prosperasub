-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060253 · unify_a1_plan_switches

-- Phase A of docs/PROVIDER_UNIFICATION.md — additive only. Nothing reads these
-- yet; they exist so the backfill can start accumulating truth.
--
-- Deliberately NOT adding `billing_period`: `provider_plans.period` already is
-- it. A second column meaning the same thing is the two-sources-of-truth bug
-- this whole plan is trying to remove. Same for `unit_label` / `unit_count`,
-- which are `included_unit` / `included_quantity`.

alter table provider_plans
  -- how many periods the checkout offers, and the range it allows
  add column if not exists periods_default int,
  add column if not exists periods_min int,
  add column if not exists periods_max int,
  -- flat | per_unit | per_person | derived
  add column if not exists pricing_mode text,
  -- only for `derived`: what the provider is owed, and what the platform adds
  add column if not exists provider_price_cents int,
  add column if not exists markup_cents int,
  -- none | visits | deliveries | resource_hours
  add column if not exists fulfilment text,
  -- what you do NOT get (cleaning's not_included, generalised)
  add column if not exists excludes jsonb,
  -- filterable attributes (food's dietary_tags, generalised)
  add column if not exists tags text[],
  -- "arrives 11:00–13:00": offset from the slot, and how wide the promise is
  add column if not exists lead_time_minutes int,
  add column if not exists window_minutes int;

alter table provider_plans drop constraint if exists provider_plans_pricing_mode_check;
alter table provider_plans add constraint provider_plans_pricing_mode_check
  check (pricing_mode is null or pricing_mode in ('flat', 'per_unit', 'per_person', 'derived'));

alter table provider_plans drop constraint if exists provider_plans_fulfilment_check;
alter table provider_plans add constraint provider_plans_fulfilment_check
  check (fulfilment is null or fulfilment in ('none', 'visits', 'deliveries', 'resource_hours'));

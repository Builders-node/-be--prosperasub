-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704234721 · f1_universal_schema_ddl


-- ── Phase 1a — DDL only ─────────────────────────────────────────────────
-- New universal service model. Sits ALONGSIDE legacy per-service tables
-- (cleaning_*, food_*, rental_*, massage_*, beach_club_*). No legacy table
-- is touched. Migration is fully additive; a follow-up migration will
-- backfill the new tables from the legacy ones.

-- 6 canonical domains. Rarely changes; seeded here so app code can rely on
-- these keys existing. `visibility_key` mirrors global_settings for opt-in.
CREATE TABLE IF NOT EXISTS public.service_categories (
  key           text PRIMARY KEY,
  label         text NOT NULL,
  icon          text NOT NULL,
  accent        text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.service_categories (key, label, icon, accent, sort_order) VALUES
  ('home',        'Home Services', 'sparkles',        'bg-blue-500',  10),
  ('food',        'Food',          'utensils-crossed','bg-emerald-500', 20),
  ('transport',   'Transport',     'car',             'bg-orange-500', 30),
  ('wellness',    'Wellness',      'heart-pulse',     'bg-rose-500',   40),
  ('venues',      'Venues',        'waves',           'bg-cyan-500',   50),
  ('activities',  'Activities',    'trophy',          'bg-amber-500',  60)
ON CONFLICT (key) DO NOTHING;

-- Universal providers table. `capabilities` is a text[] that lists which
-- offerings this provider supports: 'subscription_plans', 'hourly_bookings',
-- 'catalog_items', 'delivery', 'date_range_booking'. UI reads it to
-- decide which tabs / sections to render for a given provider.
--
-- `is_platform_owned` marks providers that the platform runs directly
-- (cleaning, beach club). `source_service_key` + `source_provider_id`
-- keep a link back to legacy rows so lookups stay resolvable during
-- migration.
CREATE TABLE IF NOT EXISTS public.providers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key     text NOT NULL REFERENCES public.service_categories(key),
  name             text NOT NULL,
  description      text,
  avatar_url       text,
  banner_url       text,
  location         text,
  working_hours    text,
  contact_phone    text,
  contact_email    text,
  capabilities     text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'active',
  sort_order       integer NOT NULL DEFAULT 0,
  admin_user_id    uuid,
  is_platform_owned boolean NOT NULL DEFAULT false,
  source_service_key text,
  source_provider_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_providers_category ON public.providers (category_key);
CREATE INDEX IF NOT EXISTS idx_providers_status   ON public.providers (status);
CREATE INDEX IF NOT EXISTS idx_providers_source   ON public.providers (source_service_key, source_provider_id) WHERE source_provider_id IS NOT NULL;

-- Bookable resources — courts, tables, rooms, vehicles. `type` is a free
-- text label ('court', 'vehicle', 'table', 'room'). `metadata` holds
-- resource-type-specific fields (transmission on a car, surface on a
-- tennis court, seat count, …) so we don't multiply per-type tables.
CREATE TABLE IF NOT EXISTS public.bookable_resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  name         text NOT NULL,
  type         text NOT NULL,
  capacity     integer,
  hours        jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'active',
  sort_order   integer NOT NULL DEFAULT 0,
  source_service_key text,
  source_resource_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookable_resources_provider ON public.bookable_resources (provider_id);
CREATE INDEX IF NOT EXISTS idx_bookable_resources_source   ON public.bookable_resources (source_service_key, source_resource_id) WHERE source_resource_id IS NOT NULL;

-- Provider plans — subscriptions, memberships, meal plans. `period`
-- captures cadence ('weekly', 'monthly', 'quarterly', 'yearly',
-- 'one_time'). `features` is JSONB for plan-type specifics
-- (meals_per_day, cleanings_per_month, gym_access_hours, …).
CREATE TABLE IF NOT EXISTS public.provider_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  price_cents  integer NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'USD',
  period       text NOT NULL DEFAULT 'monthly',
  features     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'active',
  sort_order   integer NOT NULL DEFAULT 0,
  source_service_key text,
  source_plan_id     uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_plans_provider ON public.provider_plans (provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_plans_source   ON public.provider_plans (source_service_key, source_plan_id) WHERE source_plan_id IS NOT NULL;

-- Universal bookings — spans court reservations, rental bookings, cleaning
-- bookings, food orders. `resource_id` links to a specific asset, `plan_id`
-- to a subscription plan; both are optional to accommodate hybrid models.
CREATE TABLE IF NOT EXISTS public.provider_bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  resource_id   uuid REFERENCES public.bookable_resources(id) ON DELETE SET NULL,
  plan_id       uuid REFERENCES public.provider_plans(id) ON DELETE SET NULL,
  user_id       uuid,
  start_at      timestamptz,
  end_at        timestamptz,
  status        text NOT NULL DEFAULT 'pending',
  price_cents   integer,
  payment_status text NOT NULL DEFAULT 'pending',
  payment_method text,
  payment_reference text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_service_key text,
  source_booking_id  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_bookings_provider ON public.provider_bookings (provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_bookings_user     ON public.provider_bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_provider_bookings_dates    ON public.provider_bookings (start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_provider_bookings_source   ON public.provider_bookings (source_service_key, source_booking_id) WHERE source_booking_id IS NOT NULL;

-- Universal subscriptions — memberships, meal-plan subscriptions,
-- cleaning subscriptions.
CREATE TABLE IF NOT EXISTS public.provider_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  plan_id       uuid REFERENCES public.provider_plans(id) ON DELETE SET NULL,
  user_id       uuid,
  start_date    date,
  end_date      date,
  status        text NOT NULL DEFAULT 'pending',
  payment_status text NOT NULL DEFAULT 'pending',
  payment_method text,
  payment_reference text,
  price_cents   integer,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_service_key text,
  source_subscription_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_subs_provider ON public.provider_subscriptions (provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_subs_user     ON public.provider_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_provider_subs_status   ON public.provider_subscriptions (status, payment_status);
CREATE INDEX IF NOT EXISTS idx_provider_subs_source   ON public.provider_subscriptions (source_service_key, source_subscription_id) WHERE source_subscription_id IS NOT NULL;

-- RLS: mirror the permissive pattern of the existing per-service tables so
-- the app keeps working uniformly. Backend writes via service_role remain
-- unaffected; this is the "let the app read/write freely, tighten later"
-- default that CLAUDE.md already documents for the marketplace layer.
ALTER TABLE public.service_categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.providers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookable_resources     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_bookings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY all_service_categories     ON public.service_categories     FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_providers              ON public.providers              FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_bookable_resources     ON public.bookable_resources     FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_provider_plans         ON public.provider_plans         FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_provider_bookings      ON public.provider_bookings      FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_provider_subscriptions ON public.provider_subscriptions FOR ALL TO public USING (true) WITH CHECK (true);

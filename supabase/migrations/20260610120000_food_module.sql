-- ─── Food Providers ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_providers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  description   TEXT,
  image_url     TEXT,
  weekly_price_cents  INT  NOT NULL DEFAULT 0,
  delivery_info TEXT,
  meals_per_week      INT  NOT NULL DEFAULT 0,
  status        TEXT        NOT NULL DEFAULT 'active',   -- active | inactive
  sort_order    INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Weekly Menus ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_weekly_menus (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID        NOT NULL REFERENCES public.food_providers(id) ON DELETE CASCADE,
  week_start_date DATE        NOT NULL,
  is_published    BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, week_start_date)
);

-- ─── Meals (per day within a weekly menu) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_menu_meals (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id          UUID        NOT NULL REFERENCES public.food_weekly_menus(id) ON DELETE CASCADE,
  day_of_week      TEXT        NOT NULL CHECK (day_of_week IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),
  meal_name        TEXT        NOT NULL,
  meal_description TEXT,
  sort_order       INT         NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Orders (one-time) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_orders (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT        NOT NULL,
  provider_id      UUID        NOT NULL REFERENCES public.food_providers(id),
  menu_id          UUID        REFERENCES public.food_weekly_menus(id),
  week_start_date  DATE        NOT NULL,
  total_cents      INT         NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'pending',          -- pending | confirmed | delivered | cancelled
  delivery_status  TEXT        NOT NULL DEFAULT 'pending',          -- pending | out_for_delivery | delivered
  customer_name    TEXT,
  customer_whatsapp TEXT,
  delivery_address TEXT,
  notes            TEXT,
  admin_notes      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Subscriptions (recurring weekly) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_subscriptions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  provider_id        UUID        NOT NULL REFERENCES public.food_providers(id),
  status             TEXT        NOT NULL DEFAULT 'active',  -- active | paused | cancelled
  weekly_price_cents INT         NOT NULL DEFAULT 0,
  started_at         DATE        NOT NULL DEFAULT CURRENT_DATE,
  paused_at          DATE,
  cancelled_at       DATE,
  customer_name      TEXT,
  customer_whatsapp  TEXT,
  delivery_address   TEXT,
  notes              TEXT,
  admin_notes        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Provider Images ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_provider_images (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID        NOT NULL REFERENCES public.food_providers(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.food_providers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_weekly_menus      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_menu_meals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_subscriptions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_provider_images   ENABLE ROW LEVEL SECURITY;

-- Public read for active providers and published menus
CREATE POLICY "anon_read_active_food_providers"
  ON public.food_providers FOR SELECT
  USING (status = 'active');

CREATE POLICY "anon_read_published_food_menus"
  ON public.food_weekly_menus FOR SELECT
  USING (is_published = true);

CREATE POLICY "anon_read_food_menu_meals"
  ON public.food_menu_meals FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.food_weekly_menus m
      WHERE m.id = menu_id AND m.is_published = true
    )
  );

CREATE POLICY "anon_read_food_provider_images"
  ON public.food_provider_images FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.food_providers p
      WHERE p.id = provider_id AND p.status = 'active'
    )
  );

-- Users can read their own orders/subscriptions
CREATE POLICY "user_read_own_food_orders"
  ON public.food_orders FOR SELECT
  TO authenticated
  USING ((select auth.uid())::text = user_id);

CREATE POLICY "user_insert_food_orders"
  ON public.food_orders FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid())::text = user_id);

CREATE POLICY "user_read_own_food_subscriptions"
  ON public.food_subscriptions FOR SELECT
  TO authenticated
  USING ((select auth.uid())::text = user_id);

CREATE POLICY "user_insert_food_subscriptions"
  ON public.food_subscriptions FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid())::text = user_id);

-- Service role full access (admin operations)
CREATE POLICY "service_all_food_providers"
  ON public.food_providers FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_all_food_weekly_menus"
  ON public.food_weekly_menus FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_all_food_menu_meals"
  ON public.food_menu_meals FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_all_food_orders"
  ON public.food_orders FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_all_food_subscriptions"
  ON public.food_subscriptions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_all_food_provider_images"
  ON public.food_provider_images FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ─── Seed: Chef's Weekly Menu provider ───────────────────────────────────────
INSERT INTO public.food_providers (id, name, description, weekly_price_cents, delivery_info, meals_per_week, status, sort_order)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Chef''s Weekly Menu',
  'Fresh, home-style meals delivered to your door every week. Our chef prepares a rotating seasonal menu so you always have something new to look forward to.',
  18000,
  'Delivered Monday through Friday. Cutoff for orders is Sunday at midnight. Contact us via WhatsApp for custom delivery arrangements.',
  10,
  'active',
  0
) ON CONFLICT DO NOTHING;

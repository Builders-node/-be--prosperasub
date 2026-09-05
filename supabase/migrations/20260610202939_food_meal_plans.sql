-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260610202939 · food_meal_plans


-- ─── Meal Plans (per provider/restaurant) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_meal_plans (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id        UUID        NOT NULL REFERENCES public.food_providers(id) ON DELETE CASCADE,
  name               TEXT        NOT NULL,
  description        TEXT,
  weekly_price_cents INT         NOT NULL DEFAULT 0,
  meals_per_week     INT         NOT NULL DEFAULT 0,
  days_per_week      INT         NOT NULL DEFAULT 5,
  highlights         TEXT[],                        -- bullet points shown on the card
  status             TEXT        NOT NULL DEFAULT 'active',  -- active | inactive
  sort_order         INT         NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link weekly menus to a specific meal plan (optional, NULL = provider-level menu)
ALTER TABLE public.food_weekly_menus
  ADD COLUMN IF NOT EXISTS meal_plan_id UUID REFERENCES public.food_meal_plans(id) ON DELETE SET NULL;

-- Link orders & subscriptions to a meal plan
ALTER TABLE public.food_orders
  ADD COLUMN IF NOT EXISTS meal_plan_id UUID REFERENCES public.food_meal_plans(id) ON DELETE SET NULL;

ALTER TABLE public.food_subscriptions
  ADD COLUMN IF NOT EXISTS meal_plan_id UUID REFERENCES public.food_meal_plans(id) ON DELETE SET NULL;

-- ─── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.food_meal_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_active_food_meal_plans"
  ON public.food_meal_plans FOR SELECT
  USING (status = 'active');

CREATE POLICY "service_all_food_meal_plans"
  ON public.food_meal_plans FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ─── Seed: Meal plans for Chef's Weekly Menu ─────────────────────────────────
INSERT INTO public.food_meal_plans (id, provider_id, name, description, weekly_price_cents, meals_per_week, days_per_week, highlights, status, sort_order)
VALUES
  (
    'b1c2d3e4-f5a6-7890-bcde-f12345678901',
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'Standard Plan',
    'Five freshly prepared meals delivered Monday through Friday.',
    9000,
    5,
    5,
    ARRAY['Mon–Fri delivery', '1 meal per day', 'Seasonal ingredients', 'No commitment'],
    'active',
    0
  ),
  (
    'b1c2d3e4-f5a6-7890-bcde-f12345678902',
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'Full Week Plan',
    'Seven meals covering the whole week — no cooking required.',
    14000,
    7,
    7,
    ARRAY['Mon–Sun delivery', '1 meal per day', 'Weekend specials included', 'Best value'],
    'active',
    1
  ),
  (
    'b1c2d3e4-f5a6-7890-bcde-f12345678903',
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'Family Plan',
    'Ten portions per week — enough to feed two people every weekday.',
    18000,
    10,
    5,
    ARRAY['Mon–Fri delivery', '2 portions per day', 'Family-size portions', 'Save vs individual'],
    'active',
    2
  )
ON CONFLICT DO NOTHING;

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260610220713 · food_module_scalable_v2


-- ─── Enrich restaurants with admin ownership ─────────────────────────────────
ALTER TABLE public.food_providers
  ADD COLUMN IF NOT EXISTS admin_user_id TEXT;

-- ─── Meal plans: meals_per_day ────────────────────────────────────────────────
ALTER TABLE public.food_meal_plans
  ADD COLUMN IF NOT EXISTS meals_per_day INT NOT NULL DEFAULT 3;

-- ─── Meals: image + calories ──────────────────────────────────────────────────
ALTER TABLE public.food_menu_meals
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS calories  INT;

-- ─── Subscriptions: delivery schedule ────────────────────────────────────────
ALTER TABLE public.food_subscriptions
  ADD COLUMN IF NOT EXISTS delivery_schedule JSONB;

-- ─── Order items (granular meal selection) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_order_items (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        NOT NULL REFERENCES public.food_orders(id) ON DELETE CASCADE,
  meal_id         UUID        REFERENCES public.food_menu_meals(id) ON DELETE SET NULL,
  day_of_week     TEXT        NOT NULL,
  meal_type       TEXT        NOT NULL DEFAULT 'meal',
  meal_name       TEXT        NOT NULL,
  quantity        INT         NOT NULL DEFAULT 1,
  unit_price_cents INT        NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.food_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_read_own_food_order_items"
  ON public.food_order_items FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.food_orders o
      WHERE o.id = order_id AND (select auth.uid())::text = o.user_id
    )
  );

CREATE POLICY "service_all_food_order_items"
  ON public.food_order_items FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ─── Seed updates for meals_per_day ──────────────────────────────────────────
UPDATE public.food_meal_plans SET meals_per_day = 1
  WHERE id IN (
    'b1c2d3e4-f5a6-7890-bcde-f12345678901',
    'b1c2d3e4-f5a6-7890-bcde-f12345678902'
  );

UPDATE public.food_meal_plans SET meals_per_day = 2
  WHERE id = 'b1c2d3e4-f5a6-7890-bcde-f12345678903';

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260611182508 · food_restaurant_managers


CREATE TABLE IF NOT EXISTS public.food_restaurant_managers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID        NOT NULL REFERENCES public.food_providers(id) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL,
  user_email  TEXT,
  user_name   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, user_id)
);

ALTER TABLE public.food_restaurant_managers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_food_restaurant_managers"
  ON public.food_restaurant_managers FOR ALL TO public
  USING (true) WITH CHECK (true);

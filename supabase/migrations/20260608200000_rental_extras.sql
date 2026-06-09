-- Admin-editable booking extras (add-ons) for car rentals.
CREATE TABLE IF NOT EXISTS public.rental_extras (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  description TEXT,
  price_cents INT         NOT NULL DEFAULT 0,
  price_type  TEXT        NOT NULL DEFAULT 'per_day', -- 'per_day' | 'flat'
  sort_order  INT         NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_extras_active ON public.rental_extras(is_active, sort_order);
ALTER TABLE public.rental_extras ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "all_rental_extras" ON public.rental_extras;
CREATE POLICY "all_rental_extras" ON public.rental_extras FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT ON public.rental_extras TO anon, authenticated;
GRANT ALL ON public.rental_extras TO authenticated, anon;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_extras_updated_at') THEN
    CREATE TRIGGER trg_rental_extras_updated_at BEFORE UPDATE ON public.rental_extras FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;
INSERT INTO public.rental_extras (name, price_cents, price_type, sort_order)
SELECT * FROM (VALUES
  ('Theft Protection',500,'per_day',1),('Glass & Tyre Protection',500,'per_day',2),
  ('Additional Driver',500,'per_day',3),('Baby Seat',400,'per_day',4),('Cooler',300,'per_day',5),
  ('Tank Fill',1000,'flat',6),('Custom Carwash',2000,'flat',7),('Tyre Change Service',0,'flat',8)
) AS v(name, price_cents, price_type, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.rental_extras);

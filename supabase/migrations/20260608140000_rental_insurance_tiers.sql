-- Insurance coverage tiers for car rentals, editable from the admin panel.
CREATE TABLE IF NOT EXISTS public.rental_insurance_tiers (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL,
  price_per_day_cents INT         NOT NULL DEFAULT 0,
  items               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sort_order          INT         NOT NULL DEFAULT 0,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_insurance_tiers_active ON public.rental_insurance_tiers(is_active, sort_order);

ALTER TABLE public.rental_insurance_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "all_insurance_tiers" ON public.rental_insurance_tiers;
CREATE POLICY "all_insurance_tiers" ON public.rental_insurance_tiers FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT ON public.rental_insurance_tiers TO anon, authenticated;
GRANT ALL ON public.rental_insurance_tiers TO authenticated, anon;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_insurance_tiers_updated_at') THEN
    CREATE TRIGGER trg_rental_insurance_tiers_updated_at
      BEFORE UPDATE ON public.rental_insurance_tiers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

INSERT INTO public.rental_insurance_tiers (name, price_per_day_cents, items, sort_order)
SELECT * FROM (VALUES
  ('Basic', 0, '["Collision, rollover, self-ignition","Legal assistance"]'::jsonb, 1),
  ('Plus', 1000, '["All Basic coverage","Civil liability (property)","Theft protection","Force majeure","Seniors (60-75 yrs)","Fuel service (deferred)"]'::jsonb, 2),
  ('Platinum', 2000, '["All Plus coverage","Occupant medical","Glass & tyre protection","Occupant insurance","Civil liability (persons)"]'::jsonb, 3)
) AS v(name, price_per_day_cents, items, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.rental_insurance_tiers);

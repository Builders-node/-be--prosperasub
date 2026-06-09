-- Structured, admin-editable delivery zones with per-zone fees for car rentals.
CREATE TABLE IF NOT EXISTS public.rental_delivery_zones (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  areas       TEXT,
  fee_cents   INT         NOT NULL DEFAULT 0,
  sort_order  INT         NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_delivery_zones_active ON public.rental_delivery_zones(is_active, sort_order);

ALTER TABLE public.rental_delivery_zones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "all_delivery_zones" ON public.rental_delivery_zones;
CREATE POLICY "all_delivery_zones" ON public.rental_delivery_zones FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT ON public.rental_delivery_zones TO anon, authenticated;
GRANT ALL ON public.rental_delivery_zones TO authenticated, anon;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_delivery_zones_updated_at') THEN
    CREATE TRIGGER trg_rental_delivery_zones_updated_at
      BEFORE UPDATE ON public.rental_delivery_zones FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

INSERT INTO public.rental_delivery_zones (name, areas, fee_cents, sort_order)
SELECT * FROM (VALUES
  ('Urban Zones (FREE)', 'Roatán International Airport, Utila Dream Ferry, Galaxy Wave Ferry, Coxen Hole, Brick Bay, French Harbour, Próspera, Pristine Bay, French Cay, Plan Grande, Parrot Tree', 0, 1),
  ('Mid-West', 'West End, Sandy Bay, Lawson Rock, Gravel Bay, Flowers Bay', 3000, 2),
  ('Mid-North / South', 'Milton Bight, Politily Bight, Punta Gorda, Oak Ridge', 3000, 3),
  ('West Side (Hotels Zone)', 'West Bay', 4000, 4),
  ('East Side', 'Diamond Rock, Camp Bay, Paya Bay', 4000, 5)
) AS v(name, areas, fee_cents, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.rental_delivery_zones);

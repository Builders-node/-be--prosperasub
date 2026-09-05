-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260605033208 · car_rental_module

-- Car Rental Tables
CREATE TABLE IF NOT EXISTS public.rental_vehicles (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL,
  description           TEXT,
  brand                 TEXT        NOT NULL,
  model                 TEXT        NOT NULL,
  year                  INT         NOT NULL,
  seats                 INT         NOT NULL DEFAULT 5,
  transmission          TEXT        NOT NULL DEFAULT 'automatic',
  fuel_type             TEXT        NOT NULL DEFAULT 'gasoline',
  air_conditioning      BOOLEAN     NOT NULL DEFAULT true,
  luggage_capacity      INT         NOT NULL DEFAULT 2,
  daily_price_cents     INT         NOT NULL DEFAULT 0,
  monthly_discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  status                TEXT        NOT NULL DEFAULT 'private',
  sort_order            INT         NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rental_vehicle_images (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  UUID        NOT NULL REFERENCES public.rental_vehicles(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rental_bookings (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT        NOT NULL,
  vehicle_id           UUID        NOT NULL REFERENCES public.rental_vehicles(id) ON DELETE RESTRICT,
  start_date           DATE        NOT NULL,
  end_date             DATE        NOT NULL,
  start_time           TIME        NOT NULL DEFAULT '09:00',
  end_time             TIME        NOT NULL DEFAULT '09:00',
  rental_days          INT         NOT NULL,
  daily_price_cents    INT         NOT NULL,
  subtotal_cents       INT         NOT NULL,
  discount_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
  discount_cents       INT         NOT NULL DEFAULT 0,
  total_cents          INT         NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'pending',
  payment_status       TEXT        NOT NULL DEFAULT 'pending',
  payment_method       TEXT,
  payment_reference    TEXT,
  delivery_address     TEXT,
  delivery_notes       TEXT,
  admin_notes          TEXT,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rental_delivery_settings (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_available   BOOLEAN     NOT NULL DEFAULT true,
  delivery_areas       TEXT,
  pickup_instructions  TEXT,
  delivery_fee_cents   INT         NOT NULL DEFAULT 0,
  terms_and_conditions TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rental_vehicles_status ON public.rental_vehicles(status);
CREATE INDEX IF NOT EXISTS idx_rental_vehicle_images_vehicle_id ON public.rental_vehicle_images(vehicle_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_user_id ON public.rental_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_vehicle_id ON public.rental_bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_status ON public.rental_bookings(status);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_dates ON public.rental_bookings(start_date, end_date);

-- Trigger function
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_vehicles_updated_at') THEN
    CREATE TRIGGER trg_rental_vehicles_updated_at
      BEFORE UPDATE ON public.rental_vehicles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_bookings_updated_at') THEN
    CREATE TRIGGER trg_rental_bookings_updated_at
      BEFORE UPDATE ON public.rental_bookings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

-- RLS
ALTER TABLE public.rental_vehicles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_vehicle_images    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_bookings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_delivery_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_public_vehicles"  ON public.rental_vehicles;
CREATE POLICY "anon_read_public_vehicles" ON public.rental_vehicles FOR SELECT USING (status = 'public');
DROP POLICY IF EXISTS "service_all_vehicles" ON public.rental_vehicles;
CREATE POLICY "service_all_vehicles" ON public.rental_vehicles FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "all_vehicle_images" ON public.rental_vehicle_images;
CREATE POLICY "all_vehicle_images" ON public.rental_vehicle_images FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "all_delivery_settings" ON public.rental_delivery_settings;
CREATE POLICY "all_delivery_settings" ON public.rental_delivery_settings FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "all_rental_bookings" ON public.rental_bookings;
CREATE POLICY "all_rental_bookings" ON public.rental_bookings FOR ALL USING (true) WITH CHECK (true);

-- Seed default delivery settings
INSERT INTO public.rental_delivery_settings (delivery_available, delivery_areas, pickup_instructions, delivery_fee_cents, terms_and_conditions)
SELECT true,
  'Prospera Village and surrounding areas',
  'Please arrive 15 minutes before your rental start time. Bring a valid ID and your booking confirmation.',
  0,
  'Rental vehicles must be returned in the same condition they were received. The renter is responsible for any damage during the rental period. Fuel must be returned at the same level.'
WHERE NOT EXISTS (SELECT 1 FROM public.rental_delivery_settings);

-- GRANT to anon/authenticated (needed for Data API exposure)
GRANT SELECT ON public.rental_vehicles TO anon, authenticated;
GRANT SELECT ON public.rental_vehicle_images TO anon, authenticated;
GRANT SELECT ON public.rental_delivery_settings TO anon, authenticated;
GRANT ALL ON public.rental_vehicles TO authenticated;
GRANT ALL ON public.rental_vehicle_images TO authenticated;
GRANT ALL ON public.rental_bookings TO authenticated, anon;
GRANT ALL ON public.rental_delivery_settings TO authenticated, anon;

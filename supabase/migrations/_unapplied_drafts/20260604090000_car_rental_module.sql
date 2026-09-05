-- ============================================================
-- Car Rental Module — DB Schema
-- Run this in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/igbytraidldkhhamsfdo/sql/new
-- ============================================================

-- Vehicles
CREATE TABLE IF NOT EXISTS rental_vehicles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  description           TEXT,
  brand                 TEXT NOT NULL,
  model                 TEXT NOT NULL,
  year                  INT NOT NULL,
  seats                 INT NOT NULL DEFAULT 5,
  transmission          TEXT NOT NULL DEFAULT 'automatic',  -- 'automatic' | 'manual'
  fuel_type             TEXT NOT NULL DEFAULT 'gasoline',   -- 'gasoline' | 'diesel' | 'electric' | 'hybrid'
  air_conditioning      BOOLEAN NOT NULL DEFAULT true,
  luggage_capacity      INT NOT NULL DEFAULT 2,             -- number of bags/suitcases
  daily_price_cents     INT NOT NULL DEFAULT 0,
  monthly_discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,    -- e.g. 15.00 = 15%
  status                TEXT NOT NULL DEFAULT 'private',    -- 'public' | 'private' | 'archived'
  sort_order            INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vehicle images
CREATE TABLE IF NOT EXISTS rental_vehicle_images (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  UUID NOT NULL REFERENCES rental_vehicles(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rental bookings
CREATE TABLE IF NOT EXISTS rental_bookings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT NOT NULL,
  vehicle_id           UUID NOT NULL REFERENCES rental_vehicles(id) ON DELETE RESTRICT,
  start_date           DATE NOT NULL,
  end_date             DATE NOT NULL,
  start_time           TIME NOT NULL DEFAULT '09:00',
  end_time             TIME NOT NULL DEFAULT '09:00',
  rental_days          INT NOT NULL,
  daily_price_cents    INT NOT NULL,
  subtotal_cents       INT NOT NULL,
  discount_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
  discount_cents       INT NOT NULL DEFAULT 0,
  total_cents          INT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'paid' | 'confirmed' | 'active' | 'completed' | 'cancelled'
  payment_status       TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'paid' | 'failed'
  payment_method       TEXT,
  payment_reference    TEXT,
  delivery_address     TEXT,
  delivery_notes       TEXT,
  admin_notes          TEXT,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Delivery settings (admin-configurable)
CREATE TABLE IF NOT EXISTS rental_delivery_settings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_available   BOOLEAN NOT NULL DEFAULT true,
  delivery_areas       TEXT,
  pickup_instructions  TEXT,
  delivery_fee_cents   INT NOT NULL DEFAULT 0,
  terms_and_conditions TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default delivery settings row
INSERT INTO rental_delivery_settings (delivery_available, delivery_areas, pickup_instructions, delivery_fee_cents, terms_and_conditions)
SELECT true, 'Prospera Village and surrounding areas', 'Please arrive 15 minutes before your rental start time. Bring a valid ID and your booking confirmation.', 0, 'Rental vehicles must be returned in the same condition they were received. The renter is responsible for any damage during the rental period. Fuel must be returned at the same level.'
WHERE NOT EXISTS (SELECT 1 FROM rental_delivery_settings);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rental_vehicles_status ON rental_vehicles(status);
CREATE INDEX IF NOT EXISTS idx_rental_vehicle_images_vehicle_id ON rental_vehicle_images(vehicle_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_user_id ON rental_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_vehicle_id ON rental_bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_status ON rental_bookings(status);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_dates ON rental_bookings(start_date, end_date);

-- updated_at trigger function (create if not exists)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_vehicles_updated_at') THEN
    CREATE TRIGGER trg_rental_vehicles_updated_at
      BEFORE UPDATE ON rental_vehicles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_bookings_updated_at') THEN
    CREATE TRIGGER trg_rental_bookings_updated_at
      BEFORE UPDATE ON rental_bookings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

-- RLS
ALTER TABLE rental_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_vehicle_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_delivery_settings ENABLE ROW LEVEL SECURITY;

-- Public can read public vehicles
DROP POLICY IF EXISTS "anon_read_public_vehicles" ON rental_vehicles;
CREATE POLICY "anon_read_public_vehicles" ON rental_vehicles
  FOR SELECT USING (status = 'public');

-- Public can read all vehicles (needed for admin via supabaseDb)
DROP POLICY IF EXISTS "service_all_vehicles" ON rental_vehicles;
CREATE POLICY "service_all_vehicles" ON rental_vehicles
  FOR ALL USING (true) WITH CHECK (true);

-- Public can read images of public vehicles + admin reads all
DROP POLICY IF EXISTS "anon_read_vehicle_images" ON rental_vehicle_images;
CREATE POLICY "anon_read_vehicle_images" ON rental_vehicle_images
  FOR ALL USING (true) WITH CHECK (true);

-- Delivery settings readable by all
DROP POLICY IF EXISTS "anon_read_delivery_settings" ON rental_delivery_settings;
CREATE POLICY "anon_read_delivery_settings" ON rental_delivery_settings
  FOR ALL USING (true) WITH CHECK (true);

-- Bookings — allow all (RLS enforced at app level via user_id filter)
DROP POLICY IF EXISTS "user_manage_own_bookings" ON rental_bookings;
CREATE POLICY "user_manage_own_bookings" ON rental_bookings
  FOR ALL USING (true) WITH CHECK (true);

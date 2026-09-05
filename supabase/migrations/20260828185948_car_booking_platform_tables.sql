-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260828185948 · car_booking_platform_tables

-- Standalone car-booking platform (separate subdomain app, shared Supabase).
-- Isolated tables; permissive RLS matches the platform's other browser-read
-- service tables (app-side user_id scoping). Prices in integer cents.

CREATE TABLE IF NOT EXISTS rental_vehicles (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  brand                TEXT NOT NULL DEFAULT '',
  model                TEXT NOT NULL DEFAULT '',
  year                 INT  NOT NULL DEFAULT 2024,
  seats                INT  NOT NULL DEFAULT 5,
  transmission         TEXT NOT NULL DEFAULT 'automatic',   -- automatic | manual
  fuel_type            TEXT NOT NULL DEFAULT 'gasoline',    -- gasoline|diesel|electric|hybrid
  air_conditioning     BOOLEAN NOT NULL DEFAULT true,
  luggage_capacity     INT  NOT NULL DEFAULT 2,
  description          TEXT,
  daily_price_cents    INT  NOT NULL DEFAULT 0,
  weekly_price_cents   INT  NOT NULL DEFAULT 0,   -- 0 = no weekly tier
  monthly_price_cents  INT  NOT NULL DEFAULT 0,   -- 0 = no monthly cap
  image_url            TEXT,
  gallery_urls         TEXT[] NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'public',      -- public | private | archived
  sort_order           INT  NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rental_bookings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT NOT NULL,
  vehicle_id         UUID NOT NULL REFERENCES rental_vehicles(id) ON DELETE RESTRICT,
  start_date         DATE NOT NULL,
  end_date           DATE NOT NULL,
  start_time         TIME NOT NULL DEFAULT '09:00',
  end_time           TIME NOT NULL DEFAULT '09:00',
  rental_days        INT  NOT NULL,
  daily_price_cents  INT  NOT NULL DEFAULT 0,
  subtotal_cents     INT  NOT NULL DEFAULT 0,
  discount_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,
  discount_cents     INT  NOT NULL DEFAULT 0,
  total_cents        INT  NOT NULL DEFAULT 0,     -- base charged to the provider's revenue
  surcharge_cents    INT  NOT NULL DEFAULT 0,     -- payment-method fee, NOT revenue
  customer_name      TEXT,
  customer_whatsapp  TEXT,
  delivery_address   TEXT,
  delivery_notes     TEXT,
  admin_notes        TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|confirmed|active|completed|cancelled
  payment_status     TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|failed
  payment_method     TEXT,
  payment_reference  TEXT,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_vehicles_status ON rental_vehicles(status, sort_order);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_user    ON rental_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_vehicle ON rental_bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_dates   ON rental_bookings(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_ref     ON rental_bookings(payment_reference) WHERE payment_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION rental_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rental_vehicles_touch ON rental_vehicles;
CREATE TRIGGER trg_rental_vehicles_touch BEFORE UPDATE ON rental_vehicles
  FOR EACH ROW EXECUTE FUNCTION rental_touch_updated_at();
DROP TRIGGER IF EXISTS trg_rental_bookings_touch ON rental_bookings;
CREATE TRIGGER trg_rental_bookings_touch BEFORE UPDATE ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION rental_touch_updated_at();

ALTER TABLE rental_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_vehicles_all ON rental_vehicles;
CREATE POLICY rental_vehicles_all ON rental_vehicles FOR ALL TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rental_bookings_all ON rental_bookings;
CREATE POLICY rental_bookings_all ON rental_bookings FOR ALL TO public USING (true) WITH CHECK (true);

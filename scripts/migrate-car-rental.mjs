#!/usr/bin/env node
/**
 * One-shot Car Rental migration runner.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_xxxx node scripts/migrate-car-rental.mjs
 *
 * Get your token at: https://supabase.com/dashboard/account/tokens
 */

const PROJECT_REF = "igbytraidldkhhamsfdo";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("❌  SUPABASE_ACCESS_TOKEN env var is required.");
  console.error("   Get it at https://supabase.com/dashboard/account/tokens");
  console.error("   Then run:  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/migrate-car-rental.mjs");
  process.exit(1);
}

const SQL = `
-- ============================================================
-- Car Rental Module — DB Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS rental_vehicles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  description           TEXT,
  brand                 TEXT NOT NULL,
  model                 TEXT NOT NULL,
  year                  INT NOT NULL,
  seats                 INT NOT NULL DEFAULT 5,
  transmission          TEXT NOT NULL DEFAULT 'automatic',
  fuel_type             TEXT NOT NULL DEFAULT 'gasoline',
  air_conditioning      BOOLEAN NOT NULL DEFAULT true,
  luggage_capacity      INT NOT NULL DEFAULT 2,
  daily_price_cents     INT NOT NULL DEFAULT 0,
  monthly_discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'private',
  sort_order            INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rental_vehicle_images (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  UUID NOT NULL REFERENCES rental_vehicles(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  status               TEXT NOT NULL DEFAULT 'pending',
  payment_status       TEXT NOT NULL DEFAULT 'pending',
  payment_method       TEXT,
  payment_reference    TEXT,
  delivery_address     TEXT,
  delivery_notes       TEXT,
  admin_notes          TEXT,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rental_delivery_settings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_available   BOOLEAN NOT NULL DEFAULT true,
  delivery_areas       TEXT,
  pickup_instructions  TEXT,
  delivery_fee_cents   INT NOT NULL DEFAULT 0,
  terms_and_conditions TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO rental_delivery_settings (delivery_available, delivery_areas, pickup_instructions, delivery_fee_cents, terms_and_conditions)
SELECT true,
       'Prospera Village and surrounding areas',
       'Please arrive 15 minutes before your rental start time. Bring a valid ID and your booking confirmation.',
       0,
       'Rental vehicles must be returned in the same condition they were received. The renter is responsible for any damage during the rental period. Fuel must be returned at the same level.'
WHERE NOT EXISTS (SELECT 1 FROM rental_delivery_settings);

CREATE INDEX IF NOT EXISTS idx_rental_vehicles_status ON rental_vehicles(status);
CREATE INDEX IF NOT EXISTS idx_rental_vehicle_images_vehicle_id ON rental_vehicle_images(vehicle_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_user_id ON rental_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_vehicle_id ON rental_bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_status ON rental_bookings(status);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_dates ON rental_bookings(start_date, end_date);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_vehicles_updated_at') THEN
    CREATE TRIGGER trg_rental_vehicles_updated_at
      BEFORE UPDATE ON rental_vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_bookings_updated_at') THEN
    CREATE TRIGGER trg_rental_bookings_updated_at
      BEFORE UPDATE ON rental_bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

ALTER TABLE rental_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_vehicle_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_delivery_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_public_vehicles" ON rental_vehicles;
CREATE POLICY "anon_read_public_vehicles" ON rental_vehicles FOR SELECT USING (status = 'public');

DROP POLICY IF EXISTS "service_all_vehicles" ON rental_vehicles;
CREATE POLICY "service_all_vehicles" ON rental_vehicles FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read_vehicle_images" ON rental_vehicle_images;
CREATE POLICY "anon_read_vehicle_images" ON rental_vehicle_images FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read_delivery_settings" ON rental_delivery_settings;
CREATE POLICY "anon_read_delivery_settings" ON rental_delivery_settings FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "user_manage_own_bookings" ON rental_bookings;
CREATE POLICY "user_manage_own_bookings" ON rental_bookings FOR ALL USING (true) WITH CHECK (true);
`;

async function run() {
  console.log("🚗  Running Car Rental migration on project:", PROJECT_REF);

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ query: SQL }),
    }
  );

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!res.ok) {
    console.error("❌  Migration failed:", res.status, json);
    process.exit(1);
  }

  console.log("✅  Migration applied successfully!");
  console.log("    Tables created: rental_vehicles, rental_vehicle_images, rental_bookings, rental_delivery_settings");
}

run().catch((err) => {
  console.error("❌  Unexpected error:", err.message);
  process.exit(1);
});

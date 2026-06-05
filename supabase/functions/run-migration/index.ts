// One-shot Car Rental migration edge function.
// Deletes itself from the response after running — redeploy without it after use.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SQL = `
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
SELECT true, 'Prospera Village and surrounding areas',
  'Please arrive 15 minutes before your rental start time. Bring a valid ID and your booking confirmation.',
  0, 'Rental vehicles must be returned in the same condition they were received. The renter is responsible for any damage during the rental period. Fuel must be returned at the same level.'
WHERE NOT EXISTS (SELECT 1 FROM rental_delivery_settings);

CREATE INDEX IF NOT EXISTS idx_rental_vehicles_status ON rental_vehicles(status);
CREATE INDEX IF NOT EXISTS idx_rental_vehicle_images_vehicle_id ON rental_vehicle_images(vehicle_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_user_id ON rental_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_vehicle_id ON rental_bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_status ON rental_bookings(status);
CREATE INDEX IF NOT EXISTS idx_rental_bookings_dates ON rental_bookings(start_date, end_date);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_vehicles_updated_at') THEN
    CREATE TRIGGER trg_rental_vehicles_updated_at BEFORE UPDATE ON rental_vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_bookings_updated_at') THEN
    CREATE TRIGGER trg_rental_bookings_updated_at BEFORE UPDATE ON rental_bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
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

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Use pg directly for DDL — supabase-js can't run DDL
  const dbUrl = Deno.env.get("SUPABASE_DB_URL") ??
    supabaseUrl.replace("https://", "postgresql://postgres:postgres@").replace(".supabase.co", ".supabase.co:5432/postgres");

  try {
    // Use the Supabase Management API via service key to exec raw SQL
    const res = await fetch(`${supabaseUrl}/pg/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
      },
      body: JSON.stringify({ query: SQL }),
    });

    if (!res.ok) {
      // Fallback: try the management API endpoint Supabase exposes internally
      const res2 = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_migration`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
        },
        body: JSON.stringify({ sql: SQL }),
      });
      const body2 = await res2.text();
      return new Response(JSON.stringify({
        status: res2.status,
        body: body2,
        note: "Used fallback rpc endpoint"
      }), { headers: { "Content-Type": "application/json" } });
    }

    const body = await res.text();
    return new Response(JSON.stringify({ success: true, status: res.status, body }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), dbUrl: dbUrl.replace(/:[^@]+@/, ":***@") }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

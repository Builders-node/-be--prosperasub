-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260828203635 · car_booking_addons

-- Booking add-ons: insurance tiers, extras, delivery zones (Atlantis price sheet).
CREATE TABLE IF NOT EXISTS rental_insurance_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price_per_day_cents INT NOT NULL DEFAULT 0,
  items JSONB NOT NULL DEFAULT '[]',
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rental_extras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price_cents INT NOT NULL DEFAULT 0,
  price_type TEXT NOT NULL DEFAULT 'per_day',  -- per_day | flat
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rental_delivery_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  areas TEXT,
  fee_cents INT NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE rental_bookings
  ADD COLUMN IF NOT EXISTS insurance_tier_id UUID,
  ADD COLUMN IF NOT EXISTS insurance_cents INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_zone_id UUID,
  ADD COLUMN IF NOT EXISTS delivery_fee_cents INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extras JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS extras_cents INT NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS trg_rental_ins_touch ON rental_insurance_tiers;
CREATE TRIGGER trg_rental_ins_touch BEFORE UPDATE ON rental_insurance_tiers FOR EACH ROW EXECUTE FUNCTION rental_touch_updated_at();
DROP TRIGGER IF EXISTS trg_rental_extras_touch ON rental_extras;
CREATE TRIGGER trg_rental_extras_touch BEFORE UPDATE ON rental_extras FOR EACH ROW EXECUTE FUNCTION rental_touch_updated_at();
DROP TRIGGER IF EXISTS trg_rental_zones_touch ON rental_delivery_zones;
CREATE TRIGGER trg_rental_zones_touch BEFORE UPDATE ON rental_delivery_zones FOR EACH ROW EXECUTE FUNCTION rental_touch_updated_at();

ALTER TABLE rental_insurance_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_extras ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_delivery_zones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_ins_all ON rental_insurance_tiers;
CREATE POLICY rental_ins_all ON rental_insurance_tiers FOR ALL TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rental_extras_all ON rental_extras;
CREATE POLICY rental_extras_all ON rental_extras FOR ALL TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rental_zones_all ON rental_delivery_zones;
CREATE POLICY rental_zones_all ON rental_delivery_zones FOR ALL TO public USING (true) WITH CHECK (true);

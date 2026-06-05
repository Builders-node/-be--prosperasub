-- ============================================================
-- Consolidated fix migration — 2026-06-04
-- Applies everything that is confirmed missing from the live DB:
--   1. Car Rental tables (4 tables) — confirmed 404
--   2. RBAC seed data — roles/permissions tables empty
--   3. GRANT EXECUTE on critical RPC functions (may be access-restricted)
--   4. Car rental trigger + RLS policies
-- All statements use IF NOT EXISTS / ON CONFLICT DO NOTHING — safe to re-run.
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. CAR RENTAL TABLES
-- ─────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────
-- 2. CAR RENTAL INDEXES
-- ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_rental_vehicles_status
  ON public.rental_vehicles(status);

CREATE INDEX IF NOT EXISTS idx_rental_vehicle_images_vehicle_id
  ON public.rental_vehicle_images(vehicle_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_rental_bookings_user_id
  ON public.rental_bookings(user_id);

CREATE INDEX IF NOT EXISTS idx_rental_bookings_vehicle_id
  ON public.rental_bookings(vehicle_id);

CREATE INDEX IF NOT EXISTS idx_rental_bookings_status
  ON public.rental_bookings(status);

CREATE INDEX IF NOT EXISTS idx_rental_bookings_dates
  ON public.rental_bookings(start_date, end_date);

-- ─────────────────────────────────────────────────────────────
-- 3. updated_at TRIGGER (idempotent)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_vehicles_updated_at') THEN
    CREATE TRIGGER trg_rental_vehicles_updated_at
      BEFORE UPDATE ON public.rental_vehicles
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_bookings_updated_at') THEN
    CREATE TRIGGER trg_rental_bookings_updated_at
      BEFORE UPDATE ON public.rental_bookings
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────
-- 4. CAR RENTAL RLS
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.rental_vehicles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_vehicle_images    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_bookings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_delivery_settings ENABLE ROW LEVEL SECURITY;

-- Vehicles: anon can read public ones; full access for admin (anon key used for admin too)
DROP POLICY IF EXISTS "anon_read_public_vehicles"  ON public.rental_vehicles;
CREATE POLICY "anon_read_public_vehicles" ON public.rental_vehicles
  FOR SELECT USING (status = 'public');

DROP POLICY IF EXISTS "service_all_vehicles" ON public.rental_vehicles;
CREATE POLICY "service_all_vehicles" ON public.rental_vehicles
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "all_vehicle_images" ON public.rental_vehicle_images;
CREATE POLICY "all_vehicle_images" ON public.rental_vehicle_images
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "all_delivery_settings" ON public.rental_delivery_settings;
CREATE POLICY "all_delivery_settings" ON public.rental_delivery_settings
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "all_rental_bookings" ON public.rental_bookings;
CREATE POLICY "all_rental_bookings" ON public.rental_bookings
  FOR ALL USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- 5. SEED DEFAULT DELIVERY SETTINGS ROW
-- ─────────────────────────────────────────────────────────────

INSERT INTO public.rental_delivery_settings
  (delivery_available, delivery_areas, pickup_instructions, delivery_fee_cents, terms_and_conditions)
SELECT
  true,
  'Prospera Village and surrounding areas',
  'Please arrive 15 minutes before your rental start time. Bring a valid ID and your booking confirmation.',
  0,
  'Rental vehicles must be returned in the same condition they were received. The renter is responsible for any damage during the rental period. Fuel must be returned at the same level.'
WHERE NOT EXISTS (SELECT 1 FROM public.rental_delivery_settings);

-- ─────────────────────────────────────────────────────────────
-- 6. RBAC SEED DATA (roles + permissions)
--    Uses ON CONFLICT DO NOTHING / DO UPDATE — safe to re-run
-- ─────────────────────────────────────────────────────────────

INSERT INTO public.rbac_permissions (key, category, name, description, is_admin_permission)
VALUES
  ('users.read',              'Users',          'View users',              'View user list and profiles.',                                                                            true),
  ('users.write',             'Users',          'Manage users',            'Edit, block, and delete users.',                                                                         true),
  ('clients.read',            'Clients',        'View clients',            'View cleaning clients.',                                                                                 true),
  ('clients.write',           'Clients',        'Manage clients',          'Create and edit cleaning clients.',                                                                      true),
  ('cleaning_plans.read',     'Cleaning Plans', 'View cleaning plans',     'View public and private cleaning plans.',                                                                true),
  ('cleaning_plans.write',    'Cleaning Plans', 'Manage cleaning plans',   'Create, edit, assign, and archive cleaning plans.',                                                      true),
  ('subscriptions.read',      'Subscriptions',  'View subscriptions',      'View subscriptions.',                                                                                    true),
  ('subscriptions.write',     'Subscriptions',  'Manage subscriptions',    'Create, edit, cancel, and restore subscriptions.',                                                       true),
  ('payments.read',           'Payments',       'View payments',           'View payment records and notification status.',                                                           true),
  ('payments.write',          'Payments',       'Manage payments',         'Resend payment notifications and manage payment records.',                                                true),
  ('bookings.read',           'Bookings',       'View bookings',           'View cleaning operations and bookings.',                                                                  true),
  ('bookings.write',          'Bookings',       'Manage bookings',         'Create, update, complete, and delete bookings.',                                                          true),
  ('admin_settings.read',     'Admin Settings', 'View settings',           'View admin settings.',                                                                                   true),
  ('admin_settings.write',    'Admin Settings', 'Manage settings',         'Update admin settings.',                                                                                 true),
  ('role_management.read',    'Role Management','View roles',              'View roles, permissions, and role history.',                                                              true),
  ('role_management.write',   'Role Management','Manage roles',            'Create, edit, archive, and assign roles.',                                                               true)
ON CONFLICT (key) DO UPDATE
  SET category            = EXCLUDED.category,
      name                = EXCLUDED.name,
      description         = EXCLUDED.description,
      is_admin_permission = EXCLUDED.is_admin_permission;

INSERT INTO public.rbac_roles (slug, name, description, status, is_system, is_admin_role)
VALUES
  ('admin',   'Admin',   'Administrative operator with broad platform access except protected super-admin ownership.', 'active', true, true),
  ('manager', 'Manager', 'Operations manager for clients, plans, subscriptions, bookings, and payments.',             'active', true, true),
  ('cleaner', 'Cleaner', 'Cleaning staff role with booking visibility and completion access.',                         'active', true, false),
  ('client',  'Client',  'Customer/client role with no admin panel access by default.',                               'active', true, false)
ON CONFLICT (slug) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      status      = EXCLUDED.status,
      is_system   = EXCLUDED.is_system,
      is_admin_role = EXCLUDED.is_admin_role,
      updated_at  = now();

-- Admin role → all permissions
INSERT INTO public.rbac_role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM public.rbac_roles r, public.rbac_permissions p
WHERE r.slug = 'admin'
ON CONFLICT DO NOTHING;

-- Manager role → everything except role management write + admin settings write + users write
INSERT INTO public.rbac_role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM public.rbac_roles r, public.rbac_permissions p
WHERE r.slug = 'manager'
  AND p.key NOT IN ('role_management.write', 'admin_settings.write', 'users.write')
ON CONFLICT DO NOTHING;

-- Cleaner role → bookings + clients read
INSERT INTO public.rbac_role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM public.rbac_roles r, public.rbac_permissions p
WHERE r.slug = 'cleaner'
  AND p.key IN ('bookings.read', 'bookings.write', 'clients.read')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 7. GRANT EXECUTE on key RPC functions to anon + authenticated
--    (in case Supabase revoked default PUBLIC execute grants)
-- ─────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'schedule_cleaning_subscription' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.schedule_cleaning_subscription(uuid, integer, time, text) TO anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'book_cleaning_slot' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.book_cleaning_slot TO anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_current_user_id' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_current_user_id() TO anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_role' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.has_role TO anon, authenticated';
  END IF;
END$$;

COMMIT;

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260904005148 · transport_unit_own_categories

-- Transport stops being an archetype. Its types are its own table, not
-- `service_categories` (which exists to group providers under a SERVICE):
-- a vehicle type describes the product, and transport has no service layer.
CREATE TABLE IF NOT EXISTS rental_categories (
  key text PRIMARY KEY,
  label text NOT NULL,
  icon text NOT NULL DEFAULT 'car',
  accent text NOT NULL DEFAULT 'bg-blue-500',
  image_url text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE rental_categories IS
'Vehicle types for the transport unit (Cars, Motorbikes, Boats…). Deliberately NOT service_categories: transport has no archetype and no service layer — a provider rents vehicles, and each vehicle carries its type.';

ALTER TABLE rental_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rental_categories_all ON rental_categories;
-- Permissive like every other config table: the admin CRUD writes from the
-- browser with the anon key (see CLAUDE.md).
CREATE POLICY rental_categories_all ON rental_categories
  FOR ALL TO public USING (true) WITH CHECK (true);

INSERT INTO rental_categories (key, label, icon, accent, sort_order, is_active)
VALUES ('cars', 'Cars', 'car', 'bg-amber-500', 10, true)
ON CONFLICT (key) DO NOTHING;

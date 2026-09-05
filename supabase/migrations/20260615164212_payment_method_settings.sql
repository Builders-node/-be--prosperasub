-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260615164212 · payment_method_settings

CREATE TABLE IF NOT EXISTS payment_method_settings (
  method     text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payment_method_settings (method, enabled) VALUES
  ('lightning', true), ('onchain', true), ('infinita', true)
ON CONFLICT (method) DO NOTHING;
ALTER TABLE payment_method_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS all_payment_method_settings ON payment_method_settings;
CREATE POLICY all_payment_method_settings ON payment_method_settings FOR ALL TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all_payment_method_settings ON payment_method_settings;
CREATE POLICY service_all_payment_method_settings ON payment_method_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

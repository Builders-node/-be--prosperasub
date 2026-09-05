-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260615211141 · payment_method_settings_paypal

INSERT INTO payment_method_settings (method, enabled) VALUES ('paypal', true)
ON CONFLICT (method) DO NOTHING;

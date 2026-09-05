-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260530091843 · add_audit_logs_and_soft_delete


-- Audit log table for all admin actions
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon" ON admin_audit_logs FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON admin_audit_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Add soft-delete to cleaning_clients
ALTER TABLE cleaning_clients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Add soft-delete to cleaning_packages
ALTER TABLE cleaning_packages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Add soft-delete + notes to cleaning_subscriptions
ALTER TABLE cleaning_subscriptions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE cleaning_subscriptions ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- Add status to users for blocking (already has banned_until and deleted_at)
-- Add client_id link to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id TEXT;

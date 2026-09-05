-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260531133436 · add_user_notifications


CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  related_entity_type TEXT,
  related_entity_id TEXT,
  action_url TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient_read
  ON user_notifications(recipient_user_id, is_read, is_archived);

CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient_category
  ON user_notifications(recipient_user_id, category);

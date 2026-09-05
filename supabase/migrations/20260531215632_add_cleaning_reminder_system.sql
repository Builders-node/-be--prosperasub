-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260531215632 · add_cleaning_reminder_system


-- 1. User cleaning preferences
CREATE TABLE IF NOT EXISTS user_cleaning_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_enabled BOOLEAN NOT NULL DEFAULT true,
  reminder_method TEXT NOT NULL DEFAULT 'all',
  reminder_minutes_before INTEGER NOT NULL DEFAULT 60,
  access_instructions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Reminder jobs (deduplication + tracking)
-- Note: cleaning_bookings.id is TEXT (UUID stored as text)
CREATE TABLE IF NOT EXISTS cleaning_reminder_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  methods_sent JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(booking_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reminder_jobs_status_scheduled
  ON cleaning_reminder_jobs(status, scheduled_at)
  WHERE status = 'pending';

-- 3. Access instructions on bookings
ALTER TABLE cleaning_bookings ADD COLUMN IF NOT EXISTS access_instructions TEXT;

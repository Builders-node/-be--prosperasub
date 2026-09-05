-- ============================================================
-- Migration: Disable RLS on RBAC tables + session schema changes
-- Date: 2026-06-04
-- ============================================================

BEGIN;

-- ── 1. Disable RLS on RBAC tables ────────────────────────────────────────────
-- These tables are accessed only via the NestJS backend (admin-only).
-- Access control is enforced at the application layer (AdminAuthGuard + RBAC permissions).
-- The anon key should not be able to write to these tables directly, but
-- the backend uses the service role key which bypasses RLS anyway.

ALTER TABLE IF EXISTS public.rbac_roles            DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rbac_user_roles       DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rbac_role_permissions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rbac_role_audit_logs  DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rbac_permissions      DISABLE ROW LEVEL SECURITY;

-- ── 2. User notifications table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id   UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category            TEXT        NOT NULL,   -- 'payment' | 'subscription' | 'booking' | 'reminder' | 'plan'
  type                TEXT        NOT NULL,   -- e.g. 'payment_received' | 'booking_created'
  title               TEXT        NOT NULL,
  body                TEXT        NOT NULL,
  is_read             BOOLEAN     NOT NULL DEFAULT false,
  is_archived         BOOLEAN     NOT NULL DEFAULT false,
  related_entity_type TEXT,
  related_entity_id   TEXT,
  action_url          TEXT,
  metadata            JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient_read
  ON public.user_notifications(recipient_user_id, is_read, is_archived);

CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient_category
  ON public.user_notifications(recipient_user_id, category);

-- ── 3. User cleaning preferences ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_cleaning_preferences (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        UNIQUE NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reminder_enabled        BOOLEAN     NOT NULL DEFAULT true,
  reminder_method         TEXT        NOT NULL DEFAULT 'all',   -- 'all' | 'email' | 'in_app'
  reminder_minutes_before INTEGER     NOT NULL DEFAULT 60,
  access_instructions     TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 4. Cleaning reminder jobs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cleaning_reminder_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   TEXT        NOT NULL,
  user_id      UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'pending',   -- 'pending' | 'sent' | 'skipped' | 'failed'
  methods_sent JSONB,
  error_message TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(booking_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reminder_jobs_status_scheduled
  ON public.cleaning_reminder_jobs(status, scheduled_at)
  WHERE status = 'pending';

-- ── 5. Add access_instructions to cleaning_bookings ──────────────────────────
ALTER TABLE public.cleaning_bookings
  ADD COLUMN IF NOT EXISTS access_instructions TEXT;

-- ── 6. Add whatsapp to user_profiles ─────────────────────────────────────────
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS whatsapp TEXT;

-- ── 7. Ensure rbac_user_roles id has a default (belt + suspenders) ───────────
ALTER TABLE public.rbac_user_roles
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE public.rbac_role_audit_logs
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

COMMIT;

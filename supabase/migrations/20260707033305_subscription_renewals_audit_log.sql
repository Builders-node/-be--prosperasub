-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260707033305 · subscription_renewals_audit_log

-- Renewals audit log. Every extension of any subscription lands here so we can:
--   1. Prove a renewal was paid for (payment_reference + method)
--   2. Enforce idempotency (idempotency_key UNIQUE) — client can retry safely
--   3. Answer "how many times has this sub been renewed / when / by whom"
--   4. Feed analytics (renewal-rate, time-to-renew, cohort retention)
CREATE TABLE IF NOT EXISTS subscription_renewals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service           text NOT NULL CHECK (service IN ('food','cleaning','beach','rental')),
  subscription_id   uuid NOT NULL,
  previous_end      date,
  new_start         date NOT NULL,
  new_end           date NOT NULL,
  amount_cents      integer NOT NULL CHECK (amount_cents >= 0),
  payment_method    text NOT NULL,
  payment_reference text,
  idempotency_key   uuid NOT NULL,
  renewed_by_user   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS subscription_renewals_sub_idx
  ON subscription_renewals(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_renewals_service_idx
  ON subscription_renewals(service, created_at DESC);

ALTER TABLE subscription_renewals ENABLE ROW LEVEL SECURITY;
-- Only service_role writes; users read their own via NestJS acount API.
CREATE POLICY subscription_renewals_service_all
  ON subscription_renewals FOR ALL TO service_role USING (true) WITH CHECK (true);

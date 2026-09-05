-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260904041208 · provider_order_notifications

-- One row per order we have told a business about. A checkout can fire the
-- notification from the browser AND the reconcile cron can fire it when a
-- payment lands later; the primary key is what makes the second one a no-op
-- instead of a second email. Same shape as
-- subscription_expiration_notifications, which claims its slot the same way.
CREATE TABLE IF NOT EXISTS provider_order_notifications (
  order_table text NOT NULL,
  order_id text NOT NULL,
  kind text NOT NULL DEFAULT 'new_order',
  provider_id uuid,
  recipients text[] NOT NULL DEFAULT '{}',
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_table, order_id, kind)
);

COMMENT ON TABLE provider_order_notifications IS
'De-duplication ledger for "you have a new order" emails to a provider (owner + team). Claimed with Prefer: resolution=ignore-duplicates before the mail is sent, so a browser call and a later cron confirmation cannot both notify.';

-- Service-role only: it names who was emailed about which order.
ALTER TABLE provider_order_notifications ENABLE ROW LEVEL SECURITY;

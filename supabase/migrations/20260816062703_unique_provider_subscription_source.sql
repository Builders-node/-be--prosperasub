-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816062703 · unique_provider_subscription_source

-- One universal row per legacy subscription, enforced rather than hoped for.
--
-- The 2026 backfill had no such constraint, which is why re-running it was
-- unsafe and why the beach migration needs one before it can be an upsert.
-- Partial, because a genuinely universal subscription has no source at all and
-- there may be any number of those.
create unique index if not exists provider_subscriptions_source_uniq
  on provider_subscriptions (source_service_key, source_subscription_id)
  where source_service_key is not null and source_subscription_id is not null;

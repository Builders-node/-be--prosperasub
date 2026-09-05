-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804033523 · add_surcharge_cents_to_subscription_renewals

-- The renewal audit row recorded only the service price. With PayPal live at a
-- 5% surcharge, the audit trail understated every renewal by the fee.
alter table public.subscription_renewals add column if not exists surcharge_cents integer not null default 0;
comment on column public.subscription_renewals.surcharge_cents is 'Payment-method processing fee charged on top of amount_cents. Charged = amount_cents + surcharge_cents.';

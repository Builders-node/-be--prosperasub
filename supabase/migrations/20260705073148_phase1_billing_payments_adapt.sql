-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705073148 · phase1_billing_payments_adapt

-- Adapt the (empty, unused) generic payments ledger for the Billing domain.
alter table public.payments alter column user_id drop not null;
alter table public.payments
  add column if not exists subject_ref text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;
create unique index if not exists payments_provider_ref_uidx
  on public.payments (provider, provider_ref);
create index if not exists payments_subject_ref_idx on public.payments (subject_ref);
alter table public.payments enable row level security;

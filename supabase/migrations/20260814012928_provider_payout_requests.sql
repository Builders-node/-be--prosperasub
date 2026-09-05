-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814012928 · provider_payout_requests

-- Payouts used to be admin-only bookkeeping: a row appeared when money had
-- already been sent. A provider could see the ledger but not ask for anything.
-- These columns turn the same table into a request lifecycle
-- (requested → approved → paid, or rejected) without splitting the history in
-- two, so "what am I owed" and "what was I sent" stay one query.
alter table provider_payouts
  add column if not exists status text not null default 'paid',
  add column if not exists destination text,
  add column if not exists requested_by text,
  add column if not exists requested_at timestamptz,
  add column if not exists decided_by text,
  add column if not exists decided_at timestamptz,
  add column if not exists decision_note text;

-- A requested payout has not been paid, so the timestamp cannot be required.
alter table provider_payouts alter column paid_at drop not null;

alter table provider_payouts drop constraint if exists provider_payouts_status_check;
alter table provider_payouts add constraint provider_payouts_status_check
  check (status in ('requested', 'approved', 'paid', 'rejected'));

create index if not exists provider_payouts_provider_status_idx
  on provider_payouts (provider_id, status);

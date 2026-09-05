-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260818011009 · payout_send_states

-- A payout can now be sent by the platform rather than by hand, so the row
-- needs the two states money actually passes through: it left, and it did not.
alter table provider_payouts drop constraint if exists provider_payouts_status_check;
alter table provider_payouts add constraint provider_payouts_status_check
  check (status = any (array['requested','approved','sending','paid','failed','rejected']));

-- Why a send did not go through, kept apart from decision_note so an admin's
-- own words are never overwritten by a routing error.
alter table provider_payouts add column if not exists send_error text;

comment on column provider_payouts.status is
  'requested → approved → sending → paid | failed. "sending" means the money has left our '
  'hands as far as Blink is concerned and is still routing; it counts as committed. '
  '"failed" releases it back to the provider''s available balance.';
comment on column provider_payouts.reference is
  'Lightning payment hash or on-chain txid once sent. Written by the Blink send path.';

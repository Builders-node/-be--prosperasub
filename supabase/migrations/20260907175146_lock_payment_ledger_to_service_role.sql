-- The ledger is written by NestJS with the service-role key and read by nobody
-- in the browser — verified: zero references to either table in frontend/src.
--
-- Until now both carried `FOR ALL TO anon, authenticated USING (true)
-- WITH CHECK (true)`, so anyone holding the public anon key could forge a
-- captured payment or rewrite a checkout session's amount. Ledger amounts are
-- read back from payment_checkout_sessions when a status endpoint records a
-- capture, so a forged session row becomes a forged `payments.amount_cents`.
--
-- Dropping the policies leaves RLS enabled with none, which is deny-all for
-- anon and a no-op for service_role.

drop policy if exists open_payments on public.payments;
drop policy if exists open_pcs      on public.payment_checkout_sessions;

comment on table public.payments is
  'Service-role only (RLS on, no policies). Written by NestJS; never read from the browser.';
comment on table public.payment_checkout_sessions is
  'Service-role only (RLS on, no policies). Source of truth for ledger amounts — see CLAUDE.md.';

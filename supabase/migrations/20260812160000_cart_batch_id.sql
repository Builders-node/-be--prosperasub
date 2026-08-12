-- Applied to production on 2026-08-12 via the Supabase MCP and recorded here.
--
-- One checkout, one batch — whatever mix of services was in the cart.
--
-- Only food_subscriptions had batch_id, because only food could be put in a
-- cart. Now that a basket can hold a cleaning plan next to a meal plan next to
-- a beach membership, the rows those lines produce need to be findable as one
-- purchase: the cart writes them pending when the invoice appears and promotes
-- them when the payment lands, and without a shared handle it would have to
-- keep the ids in a browser tab that may well be closed by then.
--
-- Nullable and unindexed by design: everything bought outside the cart has no
-- batch, and nothing looks a batch up except the seconds between an invoice
-- and its payment.

alter table public.cleaning_subscriptions   add column if not exists batch_id uuid;
alter table public.beach_club_subscriptions add column if not exists batch_id uuid;
alter table public.provider_subscriptions   add column if not exists batch_id uuid;

comment on column public.cleaning_subscriptions.batch_id is
  'Set when this came from the cart — shared with every other row of the same checkout, across services.';
comment on column public.beach_club_subscriptions.batch_id is
  'Set when this came from the cart — shared with every other row of the same checkout, across services.';
comment on column public.provider_subscriptions.batch_id is
  'Set when this came from the cart — shared with every other row of the same checkout, across services.';

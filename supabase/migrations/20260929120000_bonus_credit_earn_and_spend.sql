-- Bonus balance: earned on what you buy, spent on what you buy next.
--
-- Deliberately NOT a second currency. `user_credits` already is a ledger with
-- an overdraft guard, an admin adjustment path and referral grants; a separate
-- "points" unit would mean a second ledger, a conversion rate and two sets of
-- rules to keep in step. Points here ARE the balance, counted in cents, so a
-- hundred bonus is a dollar and nobody has to be told the rate.
--
-- Earning and spending sit on opposite edges on purpose:
--
--   spend  — claimed when the ORDER IS WRITTEN. That is when the customer is
--            told a smaller figure, so that is when the balance has to be
--            proven; the existing guard refuses the whole insert if it is not
--            there, and a failed checkout is recoverable in a way "you were
--            charged less than you had" is not.
--   earn   — granted when the order is PAID, because cashback on money that
--            never arrived is not cashback.
--
-- And an order that dies unpaid gives the balance back, or an abandoned
-- checkout would quietly eat it.

alter table public.user_credits drop constraint if exists user_credits_reason_ck;
alter table public.user_credits add constraint user_credits_reason_ck check (reason in (
  'referral_reward', 'referral_welcome', 'spend', 'admin_adjustment', 'refund',
  'cashback', 'spend_returned'
));

-- Off until somebody chooses a number. A cashback rate that defaults to
-- something is a discount nobody decided to give.
insert into public.global_settings (key, value) values
  ('bonus_cashback_pct',  '0'::jsonb),
  ('bonus_max_share_pct', '100'::jsonb)
on conflict (key) do nothing;

alter table public.provider_subscriptions add column if not exists credit_applied_cents integer not null default 0;
alter table public.food_subscriptions     add column if not exists credit_applied_cents integer not null default 0;
alter table public.cleaning_subscriptions add column if not exists credit_applied_cents integer not null default 0;
alter table public.rental_bookings        add column if not exists credit_applied_cents integer not null default 0;

comment on column public.provider_subscriptions.credit_applied_cents is
  'Bonus balance spent on this order. The price column keeps the full figure — the provider is paid on it — like promo_discount_cents and surcharge_cents.';

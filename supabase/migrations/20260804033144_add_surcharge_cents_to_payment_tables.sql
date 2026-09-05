-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804033144 · add_surcharge_cents_to_payment_tables

-- The payment-method surcharge (payment_method_settings.surcharge_percent —
-- PayPal is live at 5%) was charged to the customer but never recorded: every
-- write stored the base price, so admin revenue undercounted the fee and the
-- renewal endpoint verified an amount that was never charged.
--
-- Base stays base. total_cents / total_price_cents remain the SERVICE price —
-- what the provider is owed, and what every existing revenue query already
-- reduces. The processing fee gets its own column so it can be accounted for
-- separately instead of being folded into provider revenue.
--
-- Amount actually charged = base + surcharge_cents.
alter table public.cleaning_subscriptions   add column if not exists surcharge_cents integer not null default 0;
alter table public.beach_club_subscriptions add column if not exists surcharge_cents integer not null default 0;
alter table public.rental_bookings          add column if not exists surcharge_cents integer not null default 0;
alter table public.food_subscriptions       add column if not exists surcharge_cents integer not null default 0;
alter table public.subscription_periods     add column if not exists surcharge_cents integer not null default 0;

comment on column public.cleaning_subscriptions.surcharge_cents   is 'Payment-method processing fee charged on top of total_price_cents. Charged = total_price_cents + surcharge_cents.';
comment on column public.beach_club_subscriptions.surcharge_cents is 'Payment-method processing fee charged on top of total_cents. Charged = total_cents + surcharge_cents.';
comment on column public.rental_bookings.surcharge_cents          is 'Payment-method processing fee charged on top of total_cents. Charged = total_cents + surcharge_cents.';
comment on column public.food_subscriptions.surcharge_cents       is 'Payment-method processing fee charged on top of the period price. Charged = period price + surcharge_cents.';
comment on column public.subscription_periods.surcharge_cents     is 'Payment-method processing fee charged on top of amount_cents. Charged = amount_cents + surcharge_cents.';

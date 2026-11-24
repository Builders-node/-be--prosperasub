-- VAT, set once per BUSINESS, added on top of the price at checkout.
--
-- providers.vat_pct is the rate a business charges (NULL / 0 = none). Every
-- order stamps the rate it was bought at into its own vat_pct, the way
-- commission_pct is stamped — so a later change of rate never rewrites what an
-- earlier customer paid, and a renewal of that order keeps charging the rate
-- it started on.
--
-- The money: VAT = (price after promo) × vat_pct. It is charged on top of the
-- price, it is the BUSINESS's (it owes it to the tax office), and the platform
-- takes no commission on it — every earnings reader adds it at 0%. It is never
-- part of price columns, just as surcharge_cents and delivery_fee_cents are not.
--
-- Vehicles (rental_bookings) are priced server-side by their own unit and are
-- not covered here. Safe to run twice.

alter table public.providers add column if not exists vat_pct numeric(5,2);
do $$ begin
  alter table public.providers add constraint providers_vat_pct_check
    check (vat_pct is null or (vat_pct >= 0 and vat_pct <= 50));
exception when duplicate_object then null; end $$;
comment on column public.providers.vat_pct is
  'VAT this business adds on top of its prices, in percent. NULL or 0 = none. Stamped onto each order at purchase (vat_pct there).';

alter table public.provider_subscriptions add column if not exists vat_pct numeric(5,2);
alter table public.food_subscriptions     add column if not exists vat_pct numeric(5,2);
alter table public.cleaning_subscriptions add column if not exists vat_pct numeric(5,2);
comment on column public.provider_subscriptions.vat_pct is
  'VAT rate this order was bought at (from providers.vat_pct). VAT = price after promo × this, on top of the price; the business''s money, no commission. NULL = none.';
comment on column public.food_subscriptions.vat_pct is
  'VAT rate this order was bought at (from providers.vat_pct). VAT = price after promo × this, on top of the price; the business''s money, no commission. NULL = none.';
comment on column public.cleaning_subscriptions.vat_pct is
  'VAT rate this order was bought at (from providers.vat_pct). VAT = price after promo × this, on top of the price; the business''s money, no commission. NULL = none.';

create or replace function public.stamp_order_vat()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  prov uuid;
  rate numeric;
begin
  prov := public.order_universal_provider(tg_table_name, to_jsonb(new));
  select vat_pct into rate from public.providers where id = prov;
  new.vat_pct := case when coalesce(rate, 0) > 0 then rate else null end;
  return new;
exception when others then
  -- Bookkeeping never blocks an order.
  return new;
end $$;
revoke all on function public.stamp_order_vat() from public, anon, authenticated;

-- On INSERT only: the rate an order was bought at is the rate it keeps.
drop trigger if exists stamp_order_vat on public.provider_subscriptions;
create trigger stamp_order_vat before insert on public.provider_subscriptions
  for each row execute function public.stamp_order_vat();
drop trigger if exists stamp_order_vat on public.food_subscriptions;
create trigger stamp_order_vat before insert on public.food_subscriptions
  for each row execute function public.stamp_order_vat();
drop trigger if exists stamp_order_vat on public.cleaning_subscriptions;
create trigger stamp_order_vat before insert on public.cleaning_subscriptions
  for each row execute function public.stamp_order_vat();

-- Promo codes.
--
-- The whole difficulty is that a discount is money, and the browser is not
-- allowed to decide money. So the shape here is the one referrals already
-- proved: the table is service-role only, the browser may only ASK what a code
-- is worth, and a database trigger checks the answer again when the order is
-- written. Nothing trusts the number that arrives from the page.
--
-- The platform absorbs the discount, not the provider: a business did not
-- agree to a sale, so the price columns keep the full figure and the reduction
-- is recorded beside them — exactly how `surcharge_cents` already works for
-- the payment fee, and for the same reason.

create table if not exists public.promo_codes (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null,
  description        text,
  kind               text not null,
  percent_off        integer,
  amount_off_cents   integer,
  provider_id        uuid references public.providers(id) on delete cascade,
  archetype_key      text,
  min_order_cents    integer not null default 0,
  max_redemptions    integer,
  per_customer_limit integer not null default 1,
  starts_at          timestamptz,
  ends_at            timestamptz,
  status             text not null default 'active',
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint promo_codes_kind_ck   check (kind in ('percent','fixed')),
  constraint promo_codes_status_ck check (status in ('active','inactive')),
  constraint promo_codes_value_ck  check (
    (kind = 'percent' and percent_off between 1 and 100 and amount_off_cents is null) or
    (kind = 'fixed'   and amount_off_cents > 0 and percent_off is null)
  ),
  constraint promo_codes_window_ck check (ends_at is null or starts_at is null or ends_at > starts_at)
);

-- Codes are typed by people off a phone screen, so they are matched upper-case
-- and can only differ by more than their case.
create unique index if not exists promo_codes_code_uidx on public.promo_codes (upper(code));

create table if not exists public.promo_redemptions (
  id             uuid primary key default gen_random_uuid(),
  promo_id       uuid not null references public.promo_codes(id) on delete cascade,
  user_id        uuid,
  order_table    text not null,
  order_id       text not null,
  discount_cents integer not null,
  created_at     timestamptz not null default now()
);

-- One redemption per order, for ever. The reconcile cron re-reads a paid row
-- indefinitely, so "once" has to be a constraint and not a convention.
create unique index if not exists promo_redemptions_order_uidx
  on public.promo_redemptions (order_table, order_id);
create index if not exists promo_redemptions_promo_idx on public.promo_redemptions (promo_id);
create index if not exists promo_redemptions_user_idx  on public.promo_redemptions (user_id);

alter table public.promo_codes       enable row level security;
alter table public.promo_redemptions enable row level security;

comment on table public.promo_codes is
  'Service-role only. A browser may only ask promo_quote() what a code is worth; creating and editing goes through the admin API, or anyone holding the anon key could mint themselves 100% off.';
comment on table public.promo_redemptions is
  'Service-role only. One row per order, for ever — the unique index is what makes a replayed confirmation a no-op.';

alter table public.provider_subscriptions  add column if not exists promo_code text;
alter table public.provider_subscriptions  add column if not exists promo_discount_cents integer not null default 0;
alter table public.food_subscriptions      add column if not exists promo_code text;
alter table public.food_subscriptions      add column if not exists promo_discount_cents integer not null default 0;
alter table public.cleaning_subscriptions  add column if not exists promo_code text;
alter table public.cleaning_subscriptions  add column if not exists promo_discount_cents integer not null default 0;
alter table public.rental_bookings         add column if not exists promo_code text;
alter table public.rental_bookings         add column if not exists promo_discount_cents integer not null default 0;

comment on column public.provider_subscriptions.promo_discount_cents is
  'What the platform took off this order. The price column keeps the full figure — the provider is paid on it — exactly like surcharge_cents.';

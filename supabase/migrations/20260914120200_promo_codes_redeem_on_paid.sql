-- A code is spent when the money lands, not when the page is filled in.
--
-- Same reasoning as referrals: an order is marked paid by the browser at
-- checkout, by the reconcile cron, and by the Blink webhook, and only the
-- database sees all three. Counting a redemption anywhere else would either
-- miss two of them or count an abandoned checkout against the limit.

create or replace function public.promo_redeem_on_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c        public.promo_codes%rowtype;
  raw_user text;
  uid      uuid;
begin
  if new.payment_status is distinct from 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return new; end if;
  if new.promo_code is null or coalesce(new.promo_discount_cents, 0) <= 0 then return new; end if;

  select * into c from public.promo_codes where upper(code) = upper(new.promo_code) limit 1;
  if not found then return new; end if;

  raw_user := new.user_id::text;
  uid := case when raw_user ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then raw_user::uuid else null end;

  -- A discount must never be able to fail a payment.
  begin
    insert into public.promo_redemptions (promo_id, user_id, order_table, order_id, discount_cents)
    values (c.id, uid, tg_table_name::text, new.id::text, new.promo_discount_cents)
    on conflict (order_table, order_id) do nothing;
  exception when others then
    raise warning 'promo redemption failed for %:%: %', tg_table_name, new.id, sqlerrm;
  end;

  return new;
end $$;

drop trigger if exists promo_redeem on public.provider_subscriptions;
create trigger promo_redeem after insert or update of payment_status
  on public.provider_subscriptions for each row execute function public.promo_redeem_on_paid();

drop trigger if exists promo_redeem on public.cleaning_subscriptions;
create trigger promo_redeem after insert or update of payment_status
  on public.cleaning_subscriptions for each row execute function public.promo_redeem_on_paid();

drop trigger if exists promo_redeem on public.food_subscriptions;
create trigger promo_redeem after insert or update of payment_status
  on public.food_subscriptions for each row execute function public.promo_redeem_on_paid();

drop trigger if exists promo_redeem on public.rental_bookings;
create trigger promo_redeem after insert or update of payment_status
  on public.rental_bookings for each row execute function public.promo_redeem_on_paid();

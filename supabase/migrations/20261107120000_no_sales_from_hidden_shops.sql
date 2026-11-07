-- Applied 20261107120000 · no_sales_from_hidden_shops
--
-- A hidden (inactive) shop sells nothing. The plan page, checkout and cart
-- refuse it in the browser; this refuses the ORDER ROW, so a direct write with
-- the public key cannot buy from a draft either (the order tables are still
-- writable by anon — see reports/platform-audit-2026-11-06.md).
--
-- Only browser/anon writes are refused. The server (service_role) and the SQL
-- editor (no PostgREST claims) may still create a row by hand — an admin
-- recording a sale is not a customer buying from a draft.
--
-- The role is read from PostgREST's request claims, not current_user: inside a
-- SECURITY DEFINER function current_user is the owner, never the caller.

create or replace function public.reject_order_from_hidden_shop()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  caller text := coalesce(claims->>'role', '');
  prov uuid;
  prov_status text;
begin
  if claims is null or caller = 'service_role' then return new; end if;
  prov := public.order_universal_provider(tg_table_name, to_jsonb(new));
  if prov is null then return new; end if;
  select status into prov_status from public.providers where id = prov;
  if prov_status is not null and prov_status not in ('active', 'approved') then
    raise exception 'This shop is not open yet: its plans are not for sale.'
      using errcode = 'P0001', hint = 'provider_inactive';
  end if;
  return new;
end $$;
revoke all on function public.reject_order_from_hidden_shop() from public, anon, authenticated;

drop trigger if exists reject_order_from_hidden_shop on public.provider_subscriptions;
drop trigger if exists reject_order_from_hidden_shop on public.food_subscriptions;
drop trigger if exists reject_order_from_hidden_shop on public.cleaning_subscriptions;
drop trigger if exists reject_order_from_hidden_shop on public.rental_bookings;
create trigger reject_order_from_hidden_shop before insert on public.provider_subscriptions for each row execute function public.reject_order_from_hidden_shop();
create trigger reject_order_from_hidden_shop before insert on public.food_subscriptions     for each row execute function public.reject_order_from_hidden_shop();
create trigger reject_order_from_hidden_shop before insert on public.cleaning_subscriptions for each row execute function public.reject_order_from_hidden_shop();
create trigger reject_order_from_hidden_shop before insert on public.rental_bookings        for each row execute function public.reject_order_from_hidden_shop();

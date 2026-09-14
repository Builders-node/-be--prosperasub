-- What a code is worth, and the check that it was told the truth.
--
-- `promo_quote` is the only part a browser may call. It answers a question —
-- "what would this code take off an order of this size, for this person, at
-- this business?" — and has no side effect. A code is public by design: its
-- whole job is to be shared, and knowing one gets you the discount it was
-- always going to give.
--
-- `promo_guard_on_order` is the part that matters. It recomputes the same
-- answer from the row being written and refuses anything larger, so the page
-- can claim whatever it likes and still only get what the code grants.
--
-- The guard reads the row as jsonb rather than switching on tg_table_name to
-- pick a column: plpgsql resolves EVERY field reference in a CASE, not just
-- the branch it takes, so naming total_price_cents broke every table that has
-- no such column. That was caught by the first test run against the real
-- schema.

create or replace function public.promo_quote(
  p_code        text,
  p_user_id     uuid,
  p_provider_id uuid,
  p_amount_cents integer
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c        public.promo_codes%rowtype;
  used_all integer;
  used_mine integer;
  discount integer;
begin
  if coalesce(p_amount_cents, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no-amount');
  end if;

  select * into c from public.promo_codes
   where upper(code) = upper(btrim(coalesce(p_code, ''))) limit 1;
  if not found                        then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if c.status <> 'active'             then return jsonb_build_object('ok', false, 'reason', 'inactive'); end if;
  if c.starts_at is not null and now() < c.starts_at then
    return jsonb_build_object('ok', false, 'reason', 'not-yet');
  end if;
  if c.ends_at is not null and now() > c.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if c.provider_id is not null and c.provider_id is distinct from p_provider_id then
    return jsonb_build_object('ok', false, 'reason', 'wrong-business');
  end if;
  if p_amount_cents < c.min_order_cents then
    return jsonb_build_object('ok', false, 'reason', 'too-small',
                              'min_order_cents', c.min_order_cents);
  end if;

  if c.max_redemptions is not null then
    select count(*) into used_all from public.promo_redemptions where promo_id = c.id;
    if used_all >= c.max_redemptions then
      return jsonb_build_object('ok', false, 'reason', 'used-up');
    end if;
  end if;

  if p_user_id is not null and c.per_customer_limit > 0 then
    select count(*) into used_mine
      from public.promo_redemptions where promo_id = c.id and user_id = p_user_id;
    if used_mine >= c.per_customer_limit then
      return jsonb_build_object('ok', false, 'reason', 'already-used');
    end if;
  end if;

  discount := case
    when c.kind = 'percent' then (p_amount_cents * c.percent_off) / 100
    else c.amount_off_cents
  end;
  -- Never more than the order. A fixed $20 off a $15 plan is $15 off, not a
  -- payment to the customer.
  discount := least(greatest(discount, 0), p_amount_cents);

  return jsonb_build_object(
    'ok', true, 'discount_cents', discount, 'code', upper(c.code),
    'description', c.description, 'promo_id', c.id
  );
end $$;

grant execute on function public.promo_quote(text,uuid,uuid,integer) to anon, authenticated, service_role;

create or replace function public.promo_guard_on_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_json jsonb;
  base     integer;
  uid      uuid;
  quote    jsonb;
  raw_user text;
begin
  if new.promo_code is null or btrim(new.promo_code) = '' then
    if coalesce(new.promo_discount_cents, 0) <> 0 then
      raise exception 'a discount needs a promo code' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  row_json := to_jsonb(new);

  base := case tg_table_name
    when 'provider_subscriptions' then coalesce((row_json->>'price_cents')::integer, 0)
    when 'cleaning_subscriptions' then coalesce((row_json->>'total_price_cents')::integer,
                                               (row_json->>'monthly_price_cents')::integer, 0)
    when 'food_subscriptions'     then coalesce((row_json->>'weekly_price_cents')::integer, 0)
                                      * greatest(coalesce((row_json->>'commitment_weeks')::integer, 1), 1)
    when 'rental_bookings'        then coalesce((row_json->>'total_cents')::integer, 0)
    else 0 end;

  raw_user := row_json->>'user_id';
  uid := case when raw_user ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then raw_user::uuid else null end;

  quote := public.promo_quote(new.promo_code, uid, (row_json->>'provider_id')::uuid, base);

  if not (quote->>'ok')::boolean then
    raise exception 'promo code %: %', new.promo_code, quote->>'reason'
      using errcode = 'check_violation';
  end if;

  -- The page may ask for less; never for more.
  if coalesce(new.promo_discount_cents, 0) > (quote->>'discount_cents')::integer then
    raise exception 'promo code % is worth % cents, not %',
      new.promo_code, quote->>'discount_cents', new.promo_discount_cents
      using errcode = 'check_violation';
  end if;

  new.promo_code := quote->>'code';
  return new;
end $$;

drop trigger if exists promo_guard on public.provider_subscriptions;
create trigger promo_guard before insert or update of promo_code, promo_discount_cents
  on public.provider_subscriptions for each row execute function public.promo_guard_on_order();

drop trigger if exists promo_guard on public.cleaning_subscriptions;
create trigger promo_guard before insert or update of promo_code, promo_discount_cents
  on public.cleaning_subscriptions for each row execute function public.promo_guard_on_order();

drop trigger if exists promo_guard on public.food_subscriptions;
create trigger promo_guard before insert or update of promo_code, promo_discount_cents
  on public.food_subscriptions for each row execute function public.promo_guard_on_order();

drop trigger if exists promo_guard on public.rental_bookings;
create trigger promo_guard before insert or update of promo_code, promo_discount_cents
  on public.rental_bookings for each row execute function public.promo_guard_on_order();

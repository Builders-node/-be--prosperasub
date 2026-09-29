-- The three edges a bonus balance moves on.
--
-- One helper reads an order's base price out of whichever of the four tables
-- it came from. plpgsql resolves every field reference in a CASE rather than
-- the branch it takes, so this reads the row as jsonb — the same lesson the
-- promo guard learned the hard way.

create or replace function public.order_base_cents(p_table text, p_row jsonb)
returns integer language sql immutable set search_path = public as $$
  select case p_table
    when 'provider_subscriptions' then coalesce((p_row->>'price_cents')::integer, 0)
    when 'cleaning_subscriptions' then coalesce((p_row->>'total_price_cents')::integer,
                                               (p_row->>'monthly_price_cents')::integer, 0)
    when 'food_subscriptions'     then coalesce((p_row->>'weekly_price_cents')::integer, 0)
                                      * greatest(coalesce((p_row->>'commitment_weeks')::integer, 1), 1)
    when 'rental_bookings'        then coalesce((p_row->>'total_cents')::integer, 0)
    else 0 end;
$$;

/** The uuid on an order, or NULL — three of the four keep user_id as text. */
create or replace function public.order_user_uuid(p_row jsonb)
returns uuid language sql immutable set search_path = public as $$
  select case when p_row->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then (p_row->>'user_id')::uuid else null end;
$$;

-- ─── 1. spending: claimed when the order is written ─────────────────────────
create or replace function public.bonus_spend_on_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_json jsonb; base integer; uid uuid; want integer; cap integer; balance integer;
begin
  want := coalesce(new.credit_applied_cents, 0);
  if want = 0 then return new; end if;
  if want < 0 then
    raise exception 'a bonus spend cannot be negative' using errcode = 'check_violation';
  end if;

  row_json := to_jsonb(new);
  base := public.order_base_cents(tg_table_name::text, row_json);
  uid  := public.order_user_uuid(row_json);

  if uid is null then
    raise exception 'bonus can only be spent by a signed-in customer' using errcode = 'check_violation';
  end if;

  cap := least(base, (base * public.referral_setting_int('bonus_max_share_pct', 100)) / 100);
  if want > cap then
    raise exception 'bonus covers at most % cents of this order, not %', cap, want
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount_cents), 0)::integer into balance
    from public.user_credits where user_id = uid;
  if want > balance then
    raise exception 'not enough bonus: have %, tried to spend %', balance, want
      using errcode = 'check_violation';
  end if;

  -- The ledger row IS the deduction, and user_credits_guard_balance is the
  -- second pair of eyes on it: two checkouts racing for one balance leave the
  -- loser's insert refused rather than both spending it.
  insert into public.user_credits (user_id, amount_cents, reason, order_table, order_id, note)
  values (uid, -want, 'spend', tg_table_name::text, new.id::text, 'Spent at checkout');

  return new;
end $$;

-- ─── 2. earning: granted when the money lands ───────────────────────────────
--
-- Cashback is on what the customer ACTUALLY paid. An earlier version
-- subtracted only the bonus already spent, which left the promo discount
-- earning cashback: a $50 order with $10 off and $10 of bonus cost $30 and
-- paid back 10% of $40 — the platform funding the promo and then paying a
-- percentage of the part it had just given away. Caught by the test that ran
-- both on one order.
create or replace function public.bonus_earn_on_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_json jsonb; pct integer; base integer; uid uuid; earned integer;
begin
  if new.payment_status is distinct from 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return new; end if;

  pct := public.referral_setting_int('bonus_cashback_pct', 0);
  if pct <= 0 then return new; end if;

  row_json := to_jsonb(new);
  uid := public.order_user_uuid(row_json);
  if uid is null then return new; end if;

  -- Everything the platform already took off comes out first: bonus does not
  -- earn bonus, and a discount is not spending.
  base := public.order_base_cents(tg_table_name::text, row_json)
          - coalesce((row_json->>'promo_discount_cents')::integer, 0)
          - coalesce(new.credit_applied_cents, 0);
  earned := (greatest(base, 0) * pct) / 100;
  if earned <= 0 then return new; end if;

  begin
    insert into public.user_credits (user_id, amount_cents, reason, order_table, order_id, note)
    values (uid, earned, 'cashback', tg_table_name::text, new.id::text, pct || '% back');
  exception when others then
    raise warning 'cashback failed for %:%: %', tg_table_name, new.id, sqlerrm;
  end;

  return new;
end $$;

-- ─── 3. an order that dies gives the balance back ───────────────────────────
create or replace function public.bonus_return_on_dead()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_json jsonb; uid uuid; spent integer;
begin
  if coalesce(new.credit_applied_cents, 0) <= 0 then return new; end if;
  if new.payment_status not in ('expired', 'cancelled', 'failed') then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status = new.payment_status then return new; end if;

  row_json := to_jsonb(new);
  uid := public.order_user_uuid(row_json);
  if uid is null then return new; end if;

  -- What was actually taken for this order, so a partial or already-returned
  -- one cannot be returned twice.
  select coalesce(-sum(amount_cents), 0)::integer into spent
    from public.user_credits
   where user_id = uid and order_table = tg_table_name::text
     and order_id = new.id::text and reason in ('spend', 'spend_returned');
  if spent <= 0 then return new; end if;

  begin
    insert into public.user_credits (user_id, amount_cents, reason, order_table, order_id, note)
    values (uid, spent, 'spend_returned', tg_table_name::text, new.id::text, 'Order did not go through');
  exception when others then
    raise warning 'bonus return failed for %:%: %', tg_table_name, new.id, sqlerrm;
  end;

  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['provider_subscriptions','cleaning_subscriptions','food_subscriptions','rental_bookings']
  loop
    execute format('drop trigger if exists bonus_spend on public.%I', t);
    execute format('create trigger bonus_spend before insert or update of credit_applied_cents on public.%I
                    for each row execute function public.bonus_spend_on_order()', t);
    execute format('drop trigger if exists bonus_earn on public.%I', t);
    execute format('create trigger bonus_earn after insert or update of payment_status on public.%I
                    for each row execute function public.bonus_earn_on_paid()', t);
    execute format('drop trigger if exists bonus_return on public.%I', t);
    execute format('create trigger bonus_return after update of payment_status on public.%I
                    for each row execute function public.bonus_return_on_dead()', t);
  end loop;
end $$;

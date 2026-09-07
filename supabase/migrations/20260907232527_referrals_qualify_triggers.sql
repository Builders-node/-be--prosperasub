-- Referrals, part 2: the verbs.
--
-- An order is marked paid by three different writers — the browser at
-- checkout, the reconcile cron, and the Blink webhook — so the reward cannot
-- live in any one of them. It lives on a trigger, the same reasoning that put
-- mirror_legacy_occurrence there.

-- Balance is the sum of the ledger, computed, never stored.
create or replace function public.referral_balance_cents(p_user_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_cents), 0)::integer
    from public.user_credits where user_id = p_user_id;
$$;
revoke execute on function public.referral_balance_cents(uuid) from public, anon, authenticated;
grant  execute on function public.referral_balance_cents(uuid) to service_role;

create or replace function public.referral_setting_int(p_key text, p_default integer)
returns integer language sql stable set search_path = public as $$
  select coalesce((select nullif(value #>> '{}', '')::integer from public.global_settings where key = p_key), p_default);
$$;

-- ─── qualification ──────────────────────────────────────────────────────────
create or replace function public.referrals_qualify(
  p_user_id uuid, p_table text, p_order_id text
) returns void language plpgsql security definer set search_path = public as $$
declare
  r          public.referrals%rowtype;
  reward     integer;
  welcome    integer;
begin
  if p_user_id is null then return; end if;
  if coalesce((select value #>> '{}' from public.global_settings where key = 'referral_enabled'), 'true') <> 'true' then
    return;
  end if;

  select * into r from public.referrals
   where referee_user_id = p_user_id and status = 'pending'
   limit 1;
  if not found then return; end if;

  reward  := public.referral_setting_int('referral_reward_cents', 1000);
  welcome := public.referral_setting_int('referral_welcome_cents', 1000);

  -- Both sides are paid from the same statement, and the partial unique index
  -- on (referral_id, reason) is what makes a replayed confirmation a no-op
  -- rather than a second payout.
  if reward > 0 then
    insert into public.user_credits (user_id, amount_cents, reason, referral_id, order_table, order_id, note)
    values (r.referrer_user_id, reward, 'referral_reward', r.id, p_table, p_order_id,
            'Friend joined with code ' || r.code)
    on conflict do nothing;
  end if;

  if welcome > 0 then
    insert into public.user_credits (user_id, amount_cents, reason, referral_id, order_table, order_id, note)
    values (r.referee_user_id, welcome, 'referral_welcome', r.id, p_table, p_order_id,
            'Welcome credit')
    on conflict do nothing;
  end if;

  update public.referrals
     set status = 'qualified', qualified_at = now(),
         qualifying_order_table = p_table, qualifying_order_id = p_order_id
   where id = r.id and status = 'pending';
end $$;
revoke execute on function public.referrals_qualify(uuid,text,text) from public, anon, authenticated;
grant  execute on function public.referrals_qualify(uuid,text,text) to service_role;

-- ─── the trigger the four order tables share ────────────────────────────────
create or replace function public.referrals_on_order_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
  raw text;
begin
  -- Only the edge into 'paid'. An UPDATE that touches something else on an
  -- already-paid row must not look like a second purchase.
  if new.payment_status is distinct from 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return new; end if;

  raw := new.user_id::text;
  -- user_id is text on three of these tables and uuid on the fourth, and the
  -- text ones hold Google sub ids as well as uuids (see CLAUDE.md).
  if raw is null or raw !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return new;
  end if;
  uid := raw::uuid;

  -- A reward must never be able to fail a customer's payment.
  begin
    perform public.referrals_qualify(uid, tg_table_name::text, new.id::text);
  exception when others then
    raise warning 'referrals_qualify failed for %:%: %', tg_table_name, new.id, sqlerrm;
  end;

  return new;
end $$;

drop trigger if exists referrals_on_paid on public.cleaning_subscriptions;
create trigger referrals_on_paid after insert or update of payment_status on public.cleaning_subscriptions
  for each row execute function public.referrals_on_order_paid();

drop trigger if exists referrals_on_paid on public.food_subscriptions;
create trigger referrals_on_paid after insert or update of payment_status on public.food_subscriptions
  for each row execute function public.referrals_on_order_paid();

drop trigger if exists referrals_on_paid on public.provider_subscriptions;
create trigger referrals_on_paid after insert or update of payment_status on public.provider_subscriptions
  for each row execute function public.referrals_on_order_paid();

drop trigger if exists referrals_on_paid on public.rental_bookings;
create trigger referrals_on_paid after insert or update of payment_status on public.rental_bookings
  for each row execute function public.referrals_on_order_paid();

-- ─── you cannot spend what you do not have ──────────────────────────────────
create or replace function public.user_credits_guard_balance()
returns trigger language plpgsql set search_path = public as $$
declare bal integer;
begin
  if new.amount_cents >= 0 then return new; end if;
  select coalesce(sum(amount_cents), 0)::integer into bal
    from public.user_credits where user_id = new.user_id;
  if bal + new.amount_cents < 0 then
    raise exception 'credit balance too low: have %, tried to spend %', bal, -new.amount_cents
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists user_credits_guard_balance on public.user_credits;
create trigger user_credits_guard_balance
  before insert on public.user_credits
  for each row execute function public.user_credits_guard_balance();

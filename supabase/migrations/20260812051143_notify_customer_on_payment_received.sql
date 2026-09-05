-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812051143 · notify_customer_on_payment_received

-- Tell the customer their payment arrived. Every service, every payment path.
--
-- Only the cleaning checkout ever sent anything (an email, client-side). Food,
-- beach, universal plans, the cart and car bookings sent nothing at all, and no
-- checkout wrote an in-app notification. The types existed —
-- payment_received / subscription_created — but only admin.service.ts wrote
-- them, so they fired when an ADMIN created or edited a subscription and never
-- when a customer bought one. In production the last payment_received was
-- 2 July and the last subscription_created 20 July, while people kept buying
-- through August. Someone who paid on 3 August received exactly one
-- notification and it was a reminder to pay.
--
-- The rule lives here rather than in six checkouts because the writes come from
-- everywhere: the browser writes these rows directly, the reconcile cron
-- confirms Lightning and on-chain payments hours later, the renewal service
-- extends them and admins edit them by hand. The database is the only place
-- that sees all of it.
--
-- Idempotent by design: it fires on the TRANSITION to paid, and re-checks that
-- no payment_received already exists for the row, so a re-run, a double PATCH
-- or the admin path firing first can never send twice.

create or replace function public.notify_payment_received()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user      text;
  v_plan_id   text;
  v_plan_name text;
  v_label     text := tg_argv[0];   -- what the customer calls this service
  v_plan_tbl  text := tg_argv[1];   -- where to look the plan name up
  v_plan_col  text := tg_argv[2];   -- which column on THIS row points at it
begin
  -- Only the moment it becomes paid.
  if new.payment_status is distinct from 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return new; end if;

  v_user := nullif(new.user_id::text, '');
  if v_user is null then return new; end if;

  -- Already told them (admin path, an earlier re-run, a duplicate write).
  if exists (
    select 1 from user_notifications n
    where n.related_entity_id = new.id::text
      and n.type = 'payment_received'
  ) then
    return new;
  end if;

  execute format('select ($1).%I::text', v_plan_col) into v_plan_id using new;
  if v_plan_id is not null then
    execute format('select name from %I where id::text = $1 limit 1', v_plan_tbl)
      into v_plan_name using v_plan_id;
  end if;

  insert into user_notifications
    (recipient_user_id, category, type, title, body,
     related_entity_type, related_entity_id, action_url)
  values (
    v_user, 'payment', 'payment_received',
    'Payment received',
    'Your payment for ' || coalesce(v_plan_name, v_label) || ' has been confirmed.',
    v_label, new.id::text, '/my-subscriptions'
  );

  return new;
exception when others then
  -- A receipt must never be the reason a payment fails to record.
  raise warning 'notify_payment_received(%) failed for %: %', v_label, new.id, sqlerrm;
  return new;
end;
$function$;

drop trigger if exists cleaning_notify_payment_received on cleaning_subscriptions;
create trigger cleaning_notify_payment_received
  after insert or update of payment_status on cleaning_subscriptions
  for each row execute function public.notify_payment_received('cleaning_subscription', 'cleaning_packages', 'package_id');

drop trigger if exists food_notify_payment_received on food_subscriptions;
create trigger food_notify_payment_received
  after insert or update of payment_status on food_subscriptions
  for each row execute function public.notify_payment_received('food_subscription', 'food_meal_plans', 'meal_plan_id');

drop trigger if exists beach_notify_payment_received on beach_club_subscriptions;
create trigger beach_notify_payment_received
  after insert or update of payment_status on beach_club_subscriptions
  for each row execute function public.notify_payment_received('beach_club_subscription', 'beach_club_plans', 'plan_id');

drop trigger if exists provider_notify_payment_received on provider_subscriptions;
create trigger provider_notify_payment_received
  after insert or update of payment_status on provider_subscriptions
  for each row execute function public.notify_payment_received('subscription', 'provider_plans', 'plan_id');

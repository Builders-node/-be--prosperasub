-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812051303 · fix_notify_payment_received_uuid_cast

-- user_notifications.recipient_user_id is uuid; three of the four subscription
-- tables store user_id as TEXT, and some of those values are Google subject
-- ids rather than uuids. The first version passed the text straight in and
-- Postgres refused ("column recipient_user_id is of type uuid but expression
-- is of type text"), which the function's own exception handler turned into a
-- warning — so the migration reported success and no notification was ever
-- written. Same trap as apply_provider_slot_capacity; caught the same way, by
-- reading the rows back instead of trusting the result.
--
-- The regex guard is the one CLAUDE.md prescribes for this mixed id space. A
-- subscription whose user_id is not a uuid gets no notification, because there
-- is no way to address one to them — better a silent skip for those than a
-- broken insert for everybody.

create or replace function public.notify_payment_received()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user      uuid;
  v_user_txt  text;
  v_plan_id   text;
  v_plan_name text;
  v_label     text := tg_argv[0];   -- what the customer calls this service
  v_plan_tbl  text := tg_argv[1];   -- where to look the plan name up
  v_plan_col  text := tg_argv[2];   -- which column on THIS row points at it
begin
  -- Only the moment it becomes paid.
  if new.payment_status is distinct from 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return new; end if;

  v_user_txt := nullif(new.user_id::text, '');
  if v_user_txt is null then return new; end if;
  if v_user_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;
  v_user := v_user_txt::uuid;

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

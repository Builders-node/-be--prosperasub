-- The auth RPCs were never meant to be a public API.
--
-- Postgres grants EXECUTE to PUBLIC on every function it creates, so each of
-- these SECURITY DEFINER functions was reachable at /rest/v1/rpc/<name> with
-- the anon key that ships inside the browser bundle. auth_update_password in
-- particular sets any account's password by email with no caller check at all.
--
-- The backend calls them with the service-role key, so nothing it does changes.
-- The three the browser genuinely needs (decrement_slot_bookings,
-- get_food_catalog, schedule_cleaning_subscription) are deliberately untouched.

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.auth_update_password(text,text)',
    'public.auth_login_verify(text,text)',
    'public.auth_signup_user(text,text,text)',
    'public.auth_upsert_oauth_user(text,text,text,text,text)',
    'public.auth_check_email(text)',
    'public.auth_get_user_by_id(text)',
    'public.admin_list_users()',
    'public.has_role(uuid,public.app_role)',
    'public.generate_food_occurrences(integer)',
    'public.provider_item_minutes(uuid,text)',
    'public.mirror_find_occurrence(text,text,text,text,timestamptz)',
    'public.mirror_cleaning_provider_of(public.cleaning_bookings)',
    'public.mirror_rental_occurrence_one(text,uuid,uuid,text,timestamptz,text,text,text)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant  execute on function %s to service_role', fn);
  end loop;
end $$;

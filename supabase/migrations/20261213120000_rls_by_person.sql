-- Row-level security that knows who is asking.
--
-- Until now the browser called PostgREST with the anon key for everyone, so
-- about 45 tables had "anyone may do anything" policies: customer names,
-- WhatsApp numbers, addresses and notifications were readable — and plans,
-- prices, businesses and subscriptions writable — by anyone with the public
-- key. The backend now issues a short-lived database token (GET /auth/db-token,
-- signed with the project JWT secret), so a signed-in request runs as
-- `authenticated` with auth.uid() = that person. These policies key on it.
--
-- The backend (prospera_backend, service_role) bypasses RLS and is unaffected.
-- APPLY ONLY AFTER: SUPABASE_JWT_SECRET is set on the API, and the frontend that
-- sends the token is live. Before that, signed-in people would be anon too.

-- 1. Who is asking.
create or replace function public.es_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    exists (select 1 from public.user_roles ur
            where ur.user_id = auth.uid() and ur.role::text in ('super_admin', 'admin'))
    or exists (select 1 from public.rbac_user_roles ur
               join public.rbac_roles r on r.id = ur.role_id
               where ur.user_id = auth.uid()::text and ur.removed_at is null
                 and r.is_admin_role and r.status = 'active'))
$$;

-- Every provider id the person works for, in both id spaces: the universal
-- providers.id and the legacy per-service id (providers.source_provider_id),
-- because older tables still carry the legacy one.
create or replace function public.es_my_provider_ids()
returns uuid[] language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.id::text as tid, lower(u.email) as email
    from public.users u where u.id = auth.uid()
  ), direct as (
    select p.id from public.providers p, me where p.admin_user_id = me.id
    union select m.provider_id from public.provider_members m, me
      where m.user_id = me.tid or (m.user_id is null and lower(m.user_email) = me.email)
    union select m.provider_id from public.cleaning_provider_managers m, me where m.user_id = me.id
    union select m.provider_id from public.food_restaurant_managers m, me where m.user_id = me.tid
    union select m.provider_id from public.beach_provider_managers m, me where m.user_id = me.id
  )
  select coalesce(array_agg(distinct x), '{}') from (
    select d.id as x from direct d
    union select p.source_provider_id from public.providers p join direct d on d.id = p.id where p.source_provider_id is not null
    union select p.id from public.providers p join direct d on d.id = p.source_provider_id
  ) ids where x is not null
$$;

create or replace function public.es_is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (public.es_is_admin() or cardinality(public.es_my_provider_ids()) > 0)
$$;

create or replace function public.es_can_manage(p_provider uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_provider is not null and auth.uid() is not null
     and (p_provider = any (public.es_my_provider_ids()) or public.es_is_admin())
$$;

revoke all on function public.es_is_admin(), public.es_my_provider_ids(), public.es_is_staff(), public.es_can_manage(uuid) from public;
grant execute on function public.es_is_admin(), public.es_my_provider_ids(), public.es_is_staff(), public.es_can_manage(uuid) to anon, authenticated, service_role;

-- What the storefront still needs while signed out, without the rows behind it.
-- Sales per plan (for "people also buy"): counts only, no buyers.
create or replace function public.plan_sales_counts()
returns table (plan_id text, sales integer) language sql stable security definer set search_path = '' as $$
  select s.plan_id, count(*)::integer from public.subscriptions_unified s
  where s.paid and s.plan_id is not null group by s.plan_id
$$;
-- The dates a car is taken: no names, no references.
create or replace function public.rental_vehicle_holds(p_vehicle_id uuid)
returns table (start_date date, end_date date, status text, payment_status text, has_reference boolean, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.start_date, r.end_date, r.status, r.payment_status,
         coalesce(r.payment_reference, '') <> '', r.created_at
  from public.rental_bookings r
  where r.vehicle_id = p_vehicle_id and coalesce(r.status, '') <> 'cancelled' and r.deleted_at is null
$$;
grant execute on function public.plan_sales_counts(), public.rental_vehicle_holds(uuid) to anon, authenticated;

-- 2. Replace every policy on these tables (service_role ones stay; service_role bypasses RLS anyway).
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
           where schemaname = 'public' and roles <> '{service_role}'::name[]
             and tablename = any (array['providers', 'provider_plans', 'provider_items', 'bookable_resources', 'cleaning_available_slots', 'cleaning_packages', 'cleaning_providers', 'food_providers', 'food_meal_plans', 'food_provider_images', 'food_provider_residences', 'food_weekly_menus', 'beach_club_plans', 'beach_club_courts', 'cleaning_package_residences', 'food_meal_plan_residences', 'food_menu_meals', 'plan_option_groups', 'plan_options', 'service_archetypes', 'service_categories', 'resource_types', 'promo_banners', 'payment_method_settings', 'food_residences', 'user_notifications', 'food_subscriptions', 'cleaning_subscriptions', 'cleaning_clients', 'provider_subscriptions', 'rental_bookings', 'cleaning_bookings', 'cleaning_completion_reports', 'cleaning_tips', 'food_tips', 'provider_tips', 'food_delivery_logs', 'subscription_periods', 'subscription_renewals', 'user_profiles', 'support_messages', 'provider_payouts', 'login_history', 'admin_audit_logs', 'admin_payment_notifications', 'beach_club_subscriptions', 'beach_club_court_bookings', 'provider_bookings', 'food_orders', 'food_order_items', 'cleaning_plan_client_assignments', 'provider_accounts', 'provider_members', 'cleaning_provider_managers', 'food_restaurant_managers', 'beach_provider_managers', 'provider_reviews'])
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 3. Catalog: everyone reads; only the business that owns the row, or an admin, writes.
do $$
declare r record;
begin
  for r in select * from (values
    ('providers', 'public.es_can_manage(id) or public.es_can_manage(source_provider_id)'),
    ('provider_plans', 'public.es_can_manage(provider_id)'),
    ('provider_items', 'public.es_can_manage(provider_id)'),
    ('bookable_resources', 'public.es_can_manage(provider_id)'),
    ('cleaning_available_slots', 'public.es_can_manage(provider_id)'),
    ('cleaning_packages', 'public.es_can_manage(owner_provider_id) or public.es_can_manage(provider_id)'),
    ('cleaning_providers', 'public.es_can_manage(id)'),
    ('food_providers', 'public.es_can_manage(id)'),
    ('food_meal_plans', 'public.es_can_manage(provider_id)'),
    ('food_provider_images', 'public.es_can_manage(provider_id)'),
    ('food_provider_residences', 'public.es_can_manage(provider_id)'),
    ('food_weekly_menus', 'public.es_can_manage(provider_id)'),
    ('beach_club_plans', 'public.es_can_manage(owner_provider_id)'),
    ('beach_club_courts', '(select public.es_is_staff())'),
    ('cleaning_package_residences', '(select public.es_is_staff())'),
    ('food_meal_plan_residences', '(select public.es_is_staff())'),
    ('food_menu_meals', '(select public.es_is_staff())'),
    ('plan_option_groups', '(select public.es_is_staff())'),
    ('plan_options', '(select public.es_is_staff())'),
    ('service_archetypes', '(select public.es_is_admin())'),
    ('service_categories', '(select public.es_is_admin())'),
    ('resource_types', '(select public.es_is_admin())'),
    ('promo_banners', '(select public.es_is_admin())'),
    ('payment_method_settings', '(select public.es_is_admin())'),
    ('food_residences', '(select public.es_is_admin())')
  ) v(t, w) loop
    execute format('alter table public.%I enable row level security', r.t);
    execute format('create policy es_read on public.%I for select to anon, authenticated using (true)', r.t);
    execute format('create policy es_insert on public.%I for insert to authenticated with check (%s)', r.t, r.w);
    execute format('create policy es_update on public.%I for update to authenticated using (%s) with check (%s)', r.t, r.w, r.w);
    execute format('create policy es_delete on public.%I for delete to authenticated using (%s)', r.t, r.w);
  end loop;
end $$;

-- Customers move their own cleaning between slots, which updates the slot's counter directly.
create policy es_update_count on public.cleaning_available_slots for update to authenticated using (true) with check (true);

-- 4. Reviews: public read; the reviewer writes their own, the business replies, admins moderate.
create policy es_read on public.provider_reviews for select to anon, authenticated using (true);
create policy es_insert on public.provider_reviews for insert to authenticated
  with check (user_id = (select auth.uid())::text or (select public.es_is_admin()));
create policy es_update on public.provider_reviews for update to authenticated
  using (user_id = (select auth.uid())::text or public.es_can_manage(provider_id))
  with check (user_id = (select auth.uid())::text or public.es_can_manage(provider_id));
create policy es_delete on public.provider_reviews for delete to authenticated
  using (user_id = (select auth.uid())::text or public.es_can_manage(provider_id));

-- 5. Private rows: nothing for anon. Signed in: the person, their business, or an admin.
do $$
declare r record;
begin
  for r in select * from (values
    ('user_notifications', 'recipient_user_id = (select auth.uid()) or (select public.es_is_admin())', '(select public.es_is_admin())'),
    ('food_subscriptions', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)'),
    ('cleaning_subscriptions', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id) or (select public.es_is_staff())', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id) or (select public.es_is_staff())'),
    ('cleaning_clients', 'user_id = (select auth.uid()) or (select public.es_is_staff())', 'user_id = (select auth.uid()) or (select public.es_is_staff())'),
    ('provider_subscriptions', 'user_id = (select auth.uid()) or public.es_can_manage(provider_id)', 'user_id = (select auth.uid()) or public.es_can_manage(provider_id)'),
    ('rental_bookings', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)'),
    ('cleaning_bookings', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id) or (select public.es_is_staff())', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id) or (select public.es_is_staff())'),
    ('cleaning_completion_reports', '(select public.es_is_staff()) or booking_id in (select b.id::text from public.cleaning_bookings b where b.user_id = (select auth.uid())::text)', '(select public.es_is_staff()) or booking_id in (select b.id::text from public.cleaning_bookings b where b.user_id = (select auth.uid())::text)'),
    ('cleaning_tips', 'user_id = (select auth.uid())::text or (select public.es_is_staff())', 'user_id = (select auth.uid())::text or (select public.es_is_staff())'),
    ('food_tips', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)'),
    ('provider_tips', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)'),
    ('food_delivery_logs', 'public.es_can_manage(provider_id) or subscription_id in (select s.id from public.food_subscriptions s where s.user_id = (select auth.uid())::text)', 'public.es_can_manage(provider_id) or subscription_id in (select s.id from public.food_subscriptions s where s.user_id = (select auth.uid())::text)'),
    ('subscription_periods', 'user_id = (select auth.uid())::text or (select public.es_is_staff())', 'user_id = (select auth.uid())::text or (select public.es_is_staff())'),
    ('subscription_renewals', 'renewed_by_user = (select auth.uid()) or (select public.es_is_staff())', 'renewed_by_user = (select auth.uid()) or (select public.es_is_staff())'),
    ('user_profiles', 'user_id = (select auth.uid())::text or (select public.es_is_staff())', 'user_id = (select auth.uid())::text or (select public.es_is_admin())'),
    ('support_messages', '(select public.es_is_admin())', '(select public.es_is_admin())'),
    ('provider_payouts', 'public.es_can_manage(provider_id)', '(select public.es_is_admin())'),
    ('login_history', '(select public.es_is_admin())', '(select public.es_is_admin())'),
    ('admin_audit_logs', '(select public.es_is_admin())', '(select public.es_is_admin())'),
    ('admin_payment_notifications', '(select public.es_is_admin())', '(select public.es_is_admin())'),
    ('beach_club_subscriptions', 'user_id = (select auth.uid())::text or (select public.es_is_staff())', 'user_id = (select auth.uid())::text or (select public.es_is_staff())'),
    ('beach_club_court_bookings', 'user_id = (select auth.uid())::text or (select public.es_is_staff())', 'user_id = (select auth.uid())::text or (select public.es_is_staff())'),
    ('provider_bookings', 'user_id = (select auth.uid()) or public.es_can_manage(provider_id)', 'user_id = (select auth.uid()) or public.es_can_manage(provider_id)'),
    ('food_orders', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)'),
    ('food_order_items', '(select public.es_is_staff()) or order_id in (select o.id from public.food_orders o where o.user_id = (select auth.uid())::text)', '(select public.es_is_staff()) or order_id in (select o.id from public.food_orders o where o.user_id = (select auth.uid())::text)'),
    ('cleaning_plan_client_assignments', '(select public.es_is_staff())', '(select public.es_is_staff())'),
    ('provider_accounts', 'user_id = (select auth.uid())::text or (select public.es_is_admin())', 'user_id = (select auth.uid())::text or (select public.es_is_admin())'),
    ('provider_members', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)', 'public.es_can_manage(provider_id)'),
    ('cleaning_provider_managers', 'user_id = (select auth.uid()) or public.es_can_manage(provider_id)', 'public.es_can_manage(provider_id)'),
    ('food_restaurant_managers', 'user_id = (select auth.uid())::text or public.es_can_manage(provider_id)', 'public.es_can_manage(provider_id)'),
    ('beach_provider_managers', 'user_id = (select auth.uid()) or public.es_can_manage(provider_id)', 'public.es_can_manage(provider_id)')
  ) v(t, rd, w) loop
    execute format('alter table public.%I enable row level security', r.t);
    execute format('create policy es_select on public.%I for select to authenticated using (%s)', r.t, r.rd);
    execute format('create policy es_insert on public.%I for insert to authenticated with check (%s)', r.t, r.w);
    execute format('create policy es_update on public.%I for update to authenticated using (%s) with check (%s)', r.t, r.w, r.w);
    execute format('create policy es_delete on public.%I for delete to authenticated using (%s)', r.t, r.w);
  end loop;
end $$;
-- 6. Housekeeping the advisor flagged.
-- Trigger functions run with the trigger's rights; nobody needs to call them
-- through /rest/v1/rpc. (A trigger never checks EXECUTE at fire time.)
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Pin search_path on the functions that had none.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('update_updated_at_column','sync_cleaning_package_is_active','set_updated_at',
        'food_subscriptions_reject_dupe_meals','assert_plan_resources_belong_to_provider',
        'sync_provider_category_from_archetype','provider_plans_check_variant_shape',
        'provider_plans_sync_offer_price','provider_reviews_guard_reply','rental_touch_updated_at',
        'rental_booking_inherit_provider','rental_release_stale_holds')
  loop
    execute format('alter function %s set search_path = public', f.sig);
  end loop;
end $$;

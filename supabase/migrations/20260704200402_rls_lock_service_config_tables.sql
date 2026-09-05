-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704200402 · rls_lock_service_config_tables


-- Config / catalogue tables must be readable by anyone but writable only by
-- the backend (service_role). Currently they use a single permissive policy
-- that allows anon writes, which lets any client POST fake prices / delete
-- plans directly via PostgREST. All admin ops go through NestJS with the
-- service key, so tightening this does not break the app.

-- payment_method_settings
DROP POLICY IF EXISTS all_payment_method_settings ON public.payment_method_settings;
CREATE POLICY read_payment_method_settings ON public.payment_method_settings FOR SELECT TO anon, authenticated USING (true);

-- rental extras/zones/insurance
DROP POLICY IF EXISTS all_rental_extras ON public.rental_extras;
CREATE POLICY read_rental_extras ON public.rental_extras FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY service_all_rental_extras ON public.rental_extras FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS all_delivery_zones ON public.rental_delivery_zones;
CREATE POLICY read_rental_delivery_zones ON public.rental_delivery_zones FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY service_all_rental_delivery_zones ON public.rental_delivery_zones FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS all_insurance_tiers ON public.rental_insurance_tiers;
CREATE POLICY read_rental_insurance_tiers ON public.rental_insurance_tiers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY service_all_rental_insurance_tiers ON public.rental_insurance_tiers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- beach club plans / courts (config)
DROP POLICY IF EXISTS beach_club_plans_all ON public.beach_club_plans;
CREATE POLICY read_beach_club_plans ON public.beach_club_plans FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY service_all_beach_club_plans ON public.beach_club_plans FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bc_courts_all ON public.beach_club_courts;
CREATE POLICY read_beach_club_courts ON public.beach_club_courts FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY service_all_beach_club_courts ON public.beach_club_courts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- food providers / meal plans (catalogue)
DROP POLICY IF EXISTS all_food_providers ON public.food_providers;
DROP POLICY IF EXISTS all_food_meal_plans ON public.food_meal_plans;
-- service_all_* + anon_read_active_* already exist; keep them.

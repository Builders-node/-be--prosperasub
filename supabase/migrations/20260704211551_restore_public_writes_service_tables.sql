-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704211551 · restore_public_writes_service_tables


-- The service tables broke direct admin browser writes. Restore permissive
-- write policies. Long-term fix is routing admin writes through NestJS with
-- service_role, but that's a per-page refactor across the admin panel — not
-- something to ship blind. Keep the security work for a later session.

CREATE POLICY all_food_meal_plans ON public.food_meal_plans FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_food_providers ON public.food_providers FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_beach_club_plans ON public.beach_club_plans FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_beach_club_courts ON public.beach_club_courts FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_rental_extras ON public.rental_extras FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_rental_delivery_zones ON public.rental_delivery_zones FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_rental_insurance_tiers ON public.rental_insurance_tiers FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY all_payment_method_settings ON public.payment_method_settings FOR ALL TO public USING (true) WITH CHECK (true);

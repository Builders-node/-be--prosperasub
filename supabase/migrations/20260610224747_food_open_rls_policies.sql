-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260610224747 · food_open_rls_policies


-- Match the car-rental pattern: all operations open to `public`
-- (access control is enforced at the application/route level, not RLS)

CREATE POLICY "all_food_providers"
  ON public.food_providers FOR ALL TO public
  USING (true) WITH CHECK (true);

CREATE POLICY "all_food_meal_plans"
  ON public.food_meal_plans FOR ALL TO public
  USING (true) WITH CHECK (true);

CREATE POLICY "all_food_weekly_menus"
  ON public.food_weekly_menus FOR ALL TO public
  USING (true) WITH CHECK (true);

CREATE POLICY "all_food_menu_meals"
  ON public.food_menu_meals FOR ALL TO public
  USING (true) WITH CHECK (true);

CREATE POLICY "all_food_orders"
  ON public.food_orders FOR ALL TO public
  USING (true) WITH CHECK (true);

CREATE POLICY "all_food_subscriptions"
  ON public.food_subscriptions FOR ALL TO public
  USING (true) WITH CHECK (true);

CREATE POLICY "all_food_order_items"
  ON public.food_order_items FOR ALL TO public
  USING (true) WITH CHECK (true);

CREATE POLICY "all_food_provider_images"
  ON public.food_provider_images FOR ALL TO public
  USING (true) WITH CHECK (true);

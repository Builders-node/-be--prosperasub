-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902215910 · vehicles_archetype_seed

-- Car rental becomes a first-class business unit, so a rental company can be a
-- provider like a restaurant or a cleaning company is.
--
-- source_service_key stays NULL on purpose. A legacy key means "a bespoke page
-- backed by its own <service>_providers table", and approving an application
-- for one inserts there; cars have no such table and never will. Universal
-- means the approval path writes straight to `providers`, which is what a new
-- rental business needs.
--
-- The archetype and its default category reference each other, so the category
-- key is attached in a second statement.
INSERT INTO service_archetypes
  (key, label, description, icon, accent, sort_order, is_active,
   default_capabilities, default_resource_type, default_booking_model, source_service_key)
VALUES
  ('vehicles', 'Car Rental', 'Rent a car by the day, week or month.',
   'car', 'bg-amber-500', 50, true,
   '["date_range_booking"]'::jsonb, 'vehicle', 'date_range', NULL)
ON CONFLICT (key) DO NOTHING;

INSERT INTO service_categories (key, label, icon, accent, sort_order, is_active, archetype_key)
VALUES ('car_rental', 'Car Rental', 'car', 'bg-amber-500', 10, true, 'vehicles')
ON CONFLICT (key) DO NOTHING;

UPDATE service_archetypes SET category_key = 'car_rental' WHERE key = 'vehicles';

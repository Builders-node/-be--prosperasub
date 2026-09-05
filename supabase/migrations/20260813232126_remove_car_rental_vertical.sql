-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260813232126 · remove_car_rental_vertical

-- Car rental is removed from the platform.
--
-- Checked before running: 0 rows in rental_bookings, 0 provider_plans and 0
-- provider_bookings under the rental archetype, 0 provider_reviews with
-- service='rental', and no function or view in `public` referencing a
-- rental_* table. Nothing of a customer's is destroyed and nothing resolves
-- these names at run time.

-- Universal rows first: the provider FK would otherwise block the archetype.
delete from provider_bookings where source_service_key = 'rental';
delete from provider_plans where provider_id in (select id from providers where archetype_key = 'rental');
delete from providers where archetype_key = 'rental' or source_service_key = 'rental';
delete from service_categories where archetype_key = 'rental';
delete from service_archetypes where key = 'rental';

-- Then the legacy tables, children before parents.
drop table if exists rental_vehicle_residences cascade;
drop table if exists rental_vehicle_images cascade;
drop table if exists rental_bookings cascade;
drop table if exists rental_extras cascade;
drop table if exists rental_insurance_tiers cascade;
drop table if exists rental_delivery_zones cascade;
drop table if exists rental_delivery_settings cascade;
drop table if exists rental_provider_managers cascade;
drop table if exists rental_vehicles cascade;
drop table if exists rental_providers cascade;

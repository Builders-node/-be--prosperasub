-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260817222618 · retire_vehicle_resource_kind

-- The car vertical was removed from the platform — pages, routes, `rental_*`
-- tables and every read site. "Vehicle" stayed in the kind picker, first in the
-- list, so a new calendar defaulted to a kind for a service that no longer
-- exists. Deactivated, not deleted: the row survives so an old reference still
-- resolves to a label, and it comes back with one flag if cars ever do.
update public.resource_types
set is_active = false, updated_at = now()
where key = 'vehicle';

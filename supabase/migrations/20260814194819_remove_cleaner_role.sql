-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814194819 · remove_cleaner_role

-- The Cleaner role predates providers.
--
-- It was seeded as a system role so cleaning staff could see bookings and mark
-- them complete. Staff now belong to a provider and get that access through the
-- provider workspace, which is scoped to their own business rather than to
-- every booking on the platform. The role has never been assigned to anyone --
-- no live rows, no removed rows -- so this takes nothing away from anybody; it
-- only stops the admin panel offering a fifth thing that does nothing.
--
-- The two seed migrations that create it still run on a rebuilt database, which
-- is why this is a migration and not a one-off delete: it has to be replayed
-- after them.
--
-- The three permission grants (bookings.read/write, clients.read) cascade. The
-- audit log keeps its rows -- role_id is ON DELETE SET NULL -- so the record of
-- who changed what survives the role itself.
delete from public.rbac_roles where slug = 'cleaner';

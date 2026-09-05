-- Password literals replaced with __SET_VIA_ENV__ — the real value was
-- applied to the database and must not live in git. Rotate the role and
-- set the new password out of band before replaying this.
-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260528210452 · create_backend_role


-- Create a dedicated backend role for Prisma / NestJS
DO $$ BEGIN
  CREATE ROLE prospera_backend WITH LOGIN PASSWORD '__SET_VIA_ENV__' BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE prospera_backend WITH PASSWORD '__SET_VIA_ENV__';
END $$;

GRANT USAGE ON SCHEMA public TO prospera_backend;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO prospera_backend;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO prospera_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO prospera_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO prospera_backend;

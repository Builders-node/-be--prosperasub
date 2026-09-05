-- Password literals replaced with __SET_VIA_ENV__ — the real value was
-- applied to the database and must not live in git. Rotate the role and
-- set the new password out of band before replaying this.
-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260528211435 · update_backend_role_password

ALTER ROLE prospera_backend WITH PASSWORD '__SET_VIA_ENV__';

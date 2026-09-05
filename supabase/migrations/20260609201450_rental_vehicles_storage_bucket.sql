-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260609201450 · rental_vehicles_storage_bucket

-- Public bucket for car rental vehicle images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rental-vehicles',
  'rental-vehicles',
  true,
  10485760, -- 10 MB
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/gif','image/avif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read of objects in this bucket
DROP POLICY IF EXISTS "rental_vehicles_public_read" ON storage.objects;
CREATE POLICY "rental_vehicles_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'rental-vehicles');

-- Allow uploads (the admin panel uses the anon/authenticated key)
DROP POLICY IF EXISTS "rental_vehicles_insert" ON storage.objects;
CREATE POLICY "rental_vehicles_insert" ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'rental-vehicles');

-- Allow update (needed for upsert)
DROP POLICY IF EXISTS "rental_vehicles_update" ON storage.objects;
CREATE POLICY "rental_vehicles_update" ON storage.objects
  FOR UPDATE TO anon, authenticated
  USING (bucket_id = 'rental-vehicles')
  WITH CHECK (bucket_id = 'rental-vehicles');

-- Allow delete (remove replaced images)
DROP POLICY IF EXISTS "rental_vehicles_delete" ON storage.objects;
CREATE POLICY "rental_vehicles_delete" ON storage.objects
  FOR DELETE TO anon, authenticated
  USING (bucket_id = 'rental-vehicles');

-- Public storage bucket for car rental vehicle images + access policies.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('rental-vehicles', 'rental-vehicles', true, 10485760,
        ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/gif','image/avif'])
ON CONFLICT (id) DO UPDATE
  SET public = true, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "rental_vehicles_public_read" ON storage.objects;
CREATE POLICY "rental_vehicles_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'rental-vehicles');

DROP POLICY IF EXISTS "rental_vehicles_insert" ON storage.objects;
CREATE POLICY "rental_vehicles_insert" ON storage.objects
  FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'rental-vehicles');

DROP POLICY IF EXISTS "rental_vehicles_update" ON storage.objects;
CREATE POLICY "rental_vehicles_update" ON storage.objects
  FOR UPDATE TO anon, authenticated USING (bucket_id = 'rental-vehicles') WITH CHECK (bucket_id = 'rental-vehicles');

DROP POLICY IF EXISTS "rental_vehicles_delete" ON storage.objects;
CREATE POLICY "rental_vehicles_delete" ON storage.objects
  FOR DELETE TO anon, authenticated USING (bucket_id = 'rental-vehicles');

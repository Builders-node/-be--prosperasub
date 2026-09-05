-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816045841 · create_media_bucket

-- One bucket for every picture the platform stores: provider banners and
-- avatars, gallery shots, plan photographs. It replaces `vehicle-images`,
-- which was minted for the car rental that no longer exists and which every
-- uploader has been defaulting to since.
--
-- Paths inside it keep the prefixes the app already uses:
--   providers/gallery/…   plans/gallery/…   food/…
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', true, 5242880,
  array['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read: anyone. That is what "public bucket" means and what every <img> needs.
create policy "media_public_read" on storage.objects
  for select to public using (bucket_id = 'media');

-- Write: the browser, because provider CRUD runs on the anon key (see the RLS
-- note in CLAUDE.md). Update as well as insert — uploads use upsert.
create policy "media_insert" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'media');

create policy "media_update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'media') with check (bucket_id = 'media');

-- Deliberately NO delete policy. The old buckets let anyone holding the anon
-- key erase every image on the platform, and nothing in the app needs it:
-- removing a picture removes its URL from the record, not the object. The
-- service role bypasses RLS when something really has to be swept.

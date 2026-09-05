-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260815220601 · calendar_owner_email_setting

-- Who, besides the robot, can see a provisioned calendar.
--
-- The platform creates every booking calendar through a service account and
-- shares it with the provider's contact email. A provider without one — and
-- both cleaning providers are without one — ends up with a calendar only the
-- service account can open: real bookings landing somewhere no human has a
-- link to.
--
-- This address is shared on every calendar the platform creates, so the owner
-- always has them, whatever the provider has filled in. It lives in settings
-- rather than in code so it can be changed without a deploy.
insert into public.global_settings (key, value)
values ('calendar_owner_email', '"frorex.studio@gmail.com"'::jsonb)
on conflict (key) do update set value = excluded.value;

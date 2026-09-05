-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706015220 · archetype_fk_cascade_update

-- Allow renaming an archetype key to propagate to referenced rows.
alter table public.providers
  drop constraint if exists providers_archetype_key_fkey,
  add constraint providers_archetype_key_fkey
    foreign key (archetype_key) references public.service_archetypes(key)
    on update cascade on delete set null;

alter table public.provider_applications
  drop constraint if exists provider_applications_archetype_key_fkey,
  add constraint provider_applications_archetype_key_fkey
    foreign key (archetype_key) references public.service_archetypes(key)
    on update cascade on delete set null;

-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706015452 · archetype_source_service_key

alter table public.service_archetypes
  add column if not exists source_service_key text;

update public.service_archetypes set source_service_key = 'cars'     where key='rental';
update public.service_archetypes set source_service_key = 'food'     where key='food';
update public.service_archetypes set source_service_key = 'cleaning' where key='cleaning';
update public.service_archetypes set source_service_key = 'beach'    where key='beach_club';

-- Auto-populate providers.category_key from the archetype so admins never have
-- to touch it — the archetype owns the category. Applies to inserts + updates.
create or replace function public.sync_provider_category_from_archetype()
returns trigger language plpgsql as $$
declare cat text;
begin
  if new.archetype_key is not null then
    select category_key into cat from public.service_archetypes where key = new.archetype_key;
    if cat is not null then new.category_key := cat; end if;
  end if;
  return new;
end$$;

drop trigger if exists providers_sync_category_from_archetype on public.providers;
create trigger providers_sync_category_from_archetype
  before insert or update of archetype_key on public.providers
  for each row execute function public.sync_provider_category_from_archetype();

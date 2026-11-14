-- A business gets an address made of words: /services/clubs/providers/scuba-shop
-- instead of /services/clubs/providers/5a1e0000-0000-4000-8000-0000000000b4.
--
-- Readable addresses rank better and read as trustworthy in search results and
-- in a shared WhatsApp link. The uuid keeps working everywhere: the app and the
-- robot pages resolve either, and send the uuid form on to the words.
--
-- The slug is made once, from the name, and then left alone — renaming a
-- business must not break every link already shared. An admin can still set it
-- by hand.

alter table public.providers add column if not exists slug text;

create or replace function public.slugify_provider_name(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(
    trim(both '-' from
      regexp_replace(
        lower(translate(coalesce(p_name, ''),
          'ÁÀÂÄÃáàâäãÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
          'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc')),
        '[^a-z0-9]+', '-', 'g')),
    '');
$$;

-- One free slug for a name: "scuba-shop", else "scuba-shop-2", "-3"…
create or replace function public.free_provider_slug(p_name text, p_id uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  base text := coalesce(left(public.slugify_provider_name(p_name), 60), 'business');
  candidate text := base;
  n int := 1;
begin
  -- Never something that looks like an id: the router reads those as ids.
  if candidate ~ '^[0-9a-f]{8}-' then candidate := 'b-' || candidate; base := candidate; end if;
  while exists (select 1 from public.providers where slug = candidate and id <> p_id) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  return candidate;
end;
$$;

-- Live businesses first, so they get the plain names.
do $$
declare r record;
begin
  for r in
    select id, name from public.providers where slug is null
    order by (status = 'active') desc, created_at nulls last, id
  loop
    update public.providers set slug = public.free_provider_slug(r.name, r.id) where id = r.id;
  end loop;
end $$;

create unique index if not exists providers_slug_key on public.providers (slug);

create or replace function public.providers_fill_slug()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := public.free_provider_slug(new.name, new.id);
  else
    new.slug := public.slugify_provider_name(new.slug);
  end if;
  return new;
end;
$$;

drop trigger if exists providers_fill_slug on public.providers;
create trigger providers_fill_slug
  before insert or update of slug on public.providers
  for each row execute function public.providers_fill_slug();

-- The two helpers stay callable: the trigger runs as whoever inserts the
-- business, and the admin screens insert from the browser. They read nothing
-- that is not already public (names and slugs).
revoke execute on function public.providers_fill_slug() from public, anon, authenticated;

comment on column public.providers.slug is
  'The words in the business''s public address (/services/<service>/providers/<slug>). Made once from the name; not changed on rename so shared links keep working.';

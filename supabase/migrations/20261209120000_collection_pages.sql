-- Collections get a page of their own: /collections/<slug>.
--
-- Until now a collection was only a shelf on the home page — a title and up to
-- eight cards, with nowhere to go for the rest. Now each one is also a page:
-- a cover, a short text and every offer on it. The shelf on the home page gets
-- a "See all" link to it, and /collections lists them all.
--
--   slug        the words in the address ("date-night"). Unique; set from the
--               title when the collection is made, editable after. Renaming
--               the title does NOT change it, so shared links keep working.
--   cover_url   the picture at the top of the page and on the /collections card.
--   description a few sentences under the title on the page (the subtitle stays
--               the one line under the shelf on the home page).
--
-- Additive only: three nullable columns and a unique index. Nothing existing
-- changes, and the old app keeps working with them in place.

alter table public.home_collections add column if not exists slug text;
alter table public.home_collections add column if not exists cover_url text;
alter table public.home_collections add column if not exists description text;

alter table public.home_collections drop constraint if exists home_collections_slug_format;
alter table public.home_collections add constraint home_collections_slug_format
  check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60);

alter table public.home_collections drop constraint if exists home_collections_description_len;
alter table public.home_collections add constraint home_collections_description_len
  check (description is null or char_length(description) <= 600);

-- Existing rows: words from the title, "-2", "-3"… only where two titles match.
with words as (
  select id, coalesce(public.slugify_text(title), 'collection') as base,
         row_number() over (partition by coalesce(public.slugify_text(title), 'collection') order by created_at, id) as n
    from public.home_collections
   where slug is null
)
update public.home_collections c
   set slug = case when w.n = 1 then w.base else w.base || '-' || w.n end
  from words w
 where c.id = w.id;

create unique index if not exists home_collections_slug_key on public.home_collections (slug);

comment on column public.home_collections.slug is
  'Words in the public address /collections/<slug>. Set from the title on create; not changed by a rename.';
comment on column public.home_collections.cover_url is
  'Picture at the top of the collection page and on its /collections card.';
comment on column public.home_collections.description is
  'A few sentences under the title on the collection page.';

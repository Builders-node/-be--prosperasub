-- "How it works", in the business's own words.
--
-- Every business page and plan page shows a short "How it works" — the steps a
-- customer goes through. Until a business writes its own, the site shows the
-- platform's default steps (src/lib/howItWorks.ts in the front end). A
-- business can write one set for the whole business and, if a plan works
-- differently (a car rental next to a meal plan), its own set for that plan.
--
--   plan_id IS NULL   the business's steps — its page and every plan of it
--   plan_id = …       that plan's steps, ahead of the business's
--
-- No row = the default. Deleting a row is "back to default".
--
-- Its own table, not a column on providers: providers is still writable with
-- the public key (all_providers), so a column there would be editable by
-- anyone. Here the public key may only READ (it is public copy, shown to
-- guests); every write goes through the API (Edge api routes/how-it-works.ts),
-- which checks that the caller owns the business or is on its team.
--
-- The shape is checked here as well as in the API, so nothing that skips the
-- API can store a step the page cannot render: 2–6 steps, a title of 1–60
-- characters, a text of up to 240, an icon key of up to 24.
--
-- Safe to run twice.

create or replace function public.how_it_works_steps_valid(steps jsonb)
returns boolean
language sql immutable
set search_path to 'public'
as $$
  -- CASE, not AND: jsonb_array_length raises on a non-array, and SQL does
  -- not promise to stop at the first false.
  select case when jsonb_typeof(steps) <> 'array' then false else
         jsonb_array_length(steps) between 2 and 6
     and not exists (
       select 1 from jsonb_array_elements(steps) s
       where case when jsonb_typeof(s) <> 'object' then true else
             jsonb_typeof(s->'title') is distinct from 'string'
          or char_length(btrim(s->>'title')) not between 1 and 60
          or (s ? 'text' and jsonb_typeof(s->'text') not in ('string', 'null'))
          or char_length(coalesce(s->>'text', '')) > 240
          or (s ? 'icon' and jsonb_typeof(s->'icon') not in ('string', 'null'))
          or char_length(coalesce(s->>'icon', '')) > 24
          or exists (select 1 from jsonb_object_keys(s) k where k not in ('title', 'text', 'icon'))
          end
     ) end;
$$;

create table if not exists public.provider_how_it_works (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  plan_id uuid references public.provider_plans(id) on delete cascade,
  steps jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint provider_how_it_works_steps_check check (public.how_it_works_steps_valid(steps))
);

-- One business-wide row per business, one row per plan.
create unique index if not exists provider_how_it_works_business_uq
  on public.provider_how_it_works (provider_id) where plan_id is null;
create unique index if not exists provider_how_it_works_plan_uq
  on public.provider_how_it_works (plan_id) where plan_id is not null;

-- A plan's steps must belong to a plan of the same business.
create or replace function public.provider_how_it_works_check_plan()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.plan_id is not null and not exists (
    select 1 from public.provider_plans where id = new.plan_id and provider_id = new.provider_id
  ) then
    raise exception 'That plan is not one of this business''s plans' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.provider_how_it_works_check_plan() from public, anon, authenticated;
drop trigger if exists provider_how_it_works_check_plan on public.provider_how_it_works;
create trigger provider_how_it_works_check_plan before insert or update on public.provider_how_it_works
  for each row execute function public.provider_how_it_works_check_plan();

alter table public.provider_how_it_works enable row level security;
revoke all on public.provider_how_it_works from anon, authenticated;
grant select on public.provider_how_it_works to anon, authenticated;

drop policy if exists provider_how_it_works_read on public.provider_how_it_works;
create policy provider_how_it_works_read on public.provider_how_it_works
  for select to anon, authenticated using (true);
-- No insert / update / delete policy, on purpose: writes are the API's
-- (service role), after it has checked who is asking.

comment on table public.provider_how_it_works is
  'A business''s own "How it works" steps (plan_id NULL = whole business, else one plan). No row = the platform default. Public read; written only by the API for the owner or team.';
comment on column public.provider_how_it_works.steps is
  '[{title, text?, icon?}] — 2 to 6 steps, title ≤ 60, text ≤ 240, icon a key from the front end''s icon set.';

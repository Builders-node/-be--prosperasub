-- Applied to production 2026-11-07 (by the owner).
-- Owners, phase 2: replies to reviews, "you have a new review", and a log of
-- messages a business sends its subscribers.
--
-- Written by Edge `api` (routes/provider-customers.ts). Until this runs the
-- reply and broadcast endpoints answer 503; nothing else depends on it.

-- 1. A business answers a review, in public, under it.
alter table public.provider_reviews add column if not exists reply text;
alter table public.provider_reviews add column if not exists reply_at timestamptz;
alter table public.provider_reviews add column if not exists reply_by uuid;

-- provider_reviews is writable from the browser (customers post reviews with
-- the anon key), so the reply columns are guarded here: only the service role
-- (the Edge API, which checks the caller runs the business) may set them.
create or replace function public.provider_reviews_guard_reply()
returns trigger
language plpgsql
as $$
begin
  -- PostgREST runs a request as the JWT's role: anon / authenticated from a
  -- browser, service_role from the Edge API.
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    if tg_op = 'INSERT' then
      new.reply := null; new.reply_at := null; new.reply_by := null;
    else
      new.reply := old.reply; new.reply_at := old.reply_at; new.reply_by := old.reply_by;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists provider_reviews_guard_reply on public.provider_reviews;
create trigger provider_reviews_guard_reply
  before insert or update on public.provider_reviews
  for each row execute function public.provider_reviews_guard_reply();

-- 2. The owner and team hear about a new review (in-app).
create or replace function public.notify_provider_new_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recipient uuid;
begin
  for recipient in
    select p.admin_user_id from public.providers p
     where p.id = new.provider_id and p.admin_user_id is not null
    union
    select m.user_id::uuid from public.provider_members m
     where m.provider_id = new.provider_id
       and m.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  loop
    insert into public.user_notifications
      (recipient_user_id, category, type, title, body, related_entity_type, related_entity_id, action_url, metadata)
    values
      (recipient, 'business', 'provider_new_review',
       'New review: ' || coalesce(new.rating::text, '?') || '★',
       coalesce(nullif(left(new.comment, 140), ''), 'A customer rated your business.'),
       'provider_review', new.id::text,
       '/my-provider/' || new.provider_id::text,
       jsonb_build_object('provider_id', new.provider_id));
  end loop;
  return new;
exception when others then
  -- A notification must never stop a review from being saved.
  return new;
end;
$$;
revoke all on function public.notify_provider_new_review() from public, anon, authenticated;
drop trigger if exists provider_reviews_notify_owner on public.provider_reviews;
create trigger provider_reviews_notify_owner
  after insert on public.provider_reviews
  for each row execute function public.notify_provider_new_review();

-- 3. What a business told its subscribers, and when (one per day).
create table if not exists public.provider_broadcasts (
  id          uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  sent_by     uuid,
  subject     text not null,
  body        text not null,
  recipients  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists provider_broadcasts_provider_idx on public.provider_broadcasts (provider_id, created_at desc);
alter table public.provider_broadcasts enable row level security;
revoke all on table public.provider_broadcasts from anon, authenticated;

-- Referrals, part 1: the nouns.
--
-- Shape of the thing: every user carries a short code; someone who signs up
-- with it becomes their referee; when that referee's FIRST order is paid, both
-- sides get platform credit. Credit is a ledger, never a balance column — a
-- stored balance is a number that drifts away from its own history.
--
-- Nothing here is reachable with the anon key. RLS is on with no policies, the
-- way service_occurrences and the payment ledger are: this decides who gets
-- money, so the browser gets to read it through the API or not at all.

-- ─── the code ───────────────────────────────────────────────────────────────
alter table public.users add column if not exists referral_code text;

create unique index if not exists users_referral_code_uidx
  on public.users (referral_code) where referral_code is not null;

-- Crockford-ish: no O/0/I/1, because this gets read off a phone screen and
-- typed by someone who has never seen it written down.
create or replace function public.referral_new_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i integer;
begin
  for attempt in 1..40 loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from public.users where referral_code = candidate) then
      return candidate;
    end if;
  end loop;
  -- 32^6 is 1.07 billion; forty collisions in a row means something is wrong,
  -- and a signup must not fail because of it.
  return null;
end $$;

create or replace function public.users_assign_referral_code()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.referral_code is null then
    new.referral_code := public.referral_new_code();
  end if;
  return new;
end $$;

drop trigger if exists users_assign_referral_code on public.users;
create trigger users_assign_referral_code
  before insert on public.users
  for each row execute function public.users_assign_referral_code();

update public.users set referral_code = public.referral_new_code()
 where referral_code is null and deleted_at is null;

-- ─── who invited whom ───────────────────────────────────────────────────────
create table if not exists public.referrals (
  id                     uuid primary key default gen_random_uuid(),
  referrer_user_id       uuid not null references public.users(id) on delete cascade,
  -- One row per referee, for ever: being referred is something that happens to
  -- a person once, and the unique index is what makes that true rather than
  -- hoped for.
  referee_user_id        uuid not null unique references public.users(id) on delete cascade,
  code                   text not null,
  status                 text not null default 'pending',
  qualifying_order_table text,
  qualifying_order_id    text,
  qualified_at           timestamptz,
  created_at             timestamptz not null default now(),
  constraint referrals_no_self  check (referrer_user_id <> referee_user_id),
  constraint referrals_status_ck check (status in ('pending','qualified','void'))
);

create index if not exists referrals_referrer_idx on public.referrals (referrer_user_id, created_at desc);

alter table public.referrals enable row level security;

comment on table public.referrals is
  'Service-role only. One row per referee for ever (referee_user_id is unique). status: pending until the referee''s first order is paid, then qualified.';

-- ─── the credit ledger ──────────────────────────────────────────────────────
create table if not exists public.user_credits (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  -- Positive is granted, negative is spent. Balance is the sum; there is
  -- deliberately no balance column to disagree with it.
  amount_cents integer not null,
  reason       text not null,
  referral_id  uuid references public.referrals(id) on delete set null,
  order_table  text,
  order_id     text,
  note         text,
  created_at   timestamptz not null default now(),
  constraint user_credits_reason_ck check (reason in
    ('referral_reward','referral_welcome','spend','admin_adjustment','refund')),
  constraint user_credits_amount_ck check (amount_cents <> 0)
);

create index if not exists user_credits_user_idx on public.user_credits (user_id, created_at desc);

-- The grant half of a referral pays out once per side, no matter how many
-- times a confirmation is replayed. Three writers mark an order paid and the
-- reconcile cron re-reads the same row for ever, so "once" has to be a
-- constraint rather than a convention.
create unique index if not exists user_credits_referral_once_uidx
  on public.user_credits (referral_id, reason)
  where referral_id is not null and reason in ('referral_reward','referral_welcome');

alter table public.user_credits enable row level security;

comment on table public.user_credits is
  'Service-role only. Append-only ledger: balance = sum(amount_cents). Positive granted, negative spent.';

-- ─── the knobs ──────────────────────────────────────────────────────────────
insert into public.global_settings (key, value) values
  ('referral_enabled',       'true'::jsonb),
  ('referral_reward_cents',  '1000'::jsonb),
  ('referral_welcome_cents', '1000'::jsonb)
on conflict (key) do nothing;

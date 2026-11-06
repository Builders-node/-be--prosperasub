-- Applied 20261106120000 · provider_clients_commission
--
-- "Bring your own clients, pay no commission on them."
--
-- A business gets a code (providers.client_code). A customer who arrives on
-- its QR (?ref=CODE) or types the code becomes that business's client
-- (provider_clients), and every order that customer then places WITH THAT
-- BUSINESS carries 0% commission. Orders with anyone else are unaffected.
--
-- Who counts as "their" client: a new account, or one that has never paid this
-- business for anything. Otherwise a business could move the customers the
-- platform brought it onto its own code. The link does not expire.
--
-- The rate is written onto the ORDER when it is created (commission_pct on the
-- four order tables), by a trigger, so every writer is covered — the browser,
-- Nest, the Edge function and the PayPal webhook — and a later change of a
-- provider's rate no longer rewrites its history. NULL (every row from before
-- this migration) means "the provider's current rate", which is what readers
-- did before. The trigger overwrites whatever a writer sent: the rate is not
-- the browser's to choose.

-- ─── the code ──────────────────────────────────────────────────────────────
alter table public.providers add column if not exists client_code text;
comment on column public.providers.client_code is
  'Code a business hands its own clients (QR ?ref=CODE, or typed). Clients who join on it pay no platform commission on this business''s orders. A–Z/0–9, 4–12 chars, unique, shares the ?ref= namespace with users.referral_code.';

create or replace function public.provider_client_code_from(p_name text, p_self uuid)
returns text language plpgsql security definer set search_path = public as $$
declare base text; candidate text; n int := 1;
begin
  base := upper(regexp_replace(translate(coalesce(p_name, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'), '[^A-Za-z0-9]', '', 'g'));
  base := left(base, 10);
  if length(base) < 4 then base := rpad(base || 'SUB', 4, 'X'); end if;
  candidate := base;
  while exists (select 1 from public.providers where upper(client_code) = candidate and id is distinct from p_self)
     or exists (select 1 from public.users where upper(referral_code) = candidate) loop
    n := n + 1;
    candidate := left(base, 12 - length(n::text)) || n::text;
  end loop;
  return candidate;
end $$;
revoke all on function public.provider_client_code_from(text, uuid) from public, anon, authenticated;

do $$ declare r record; begin
  for r in select id, name from public.providers where client_code is null order by created_at loop
    update public.providers set client_code = public.provider_client_code_from(r.name, r.id) where id = r.id;
  end loop;
end $$;

create unique index if not exists providers_client_code_uidx on public.providers (upper(client_code)) where client_code is not null;
alter table public.providers drop constraint if exists providers_client_code_format;
alter table public.providers add constraint providers_client_code_format check (client_code is null or client_code ~ '^[A-Z0-9]{4,12}$');

create or replace function public.providers_fill_client_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.client_code is null then new.client_code := public.provider_client_code_from(new.name, new.id); end if;
  new.client_code := upper(new.client_code);
  return new;
end $$;
revoke all on function public.providers_fill_client_code() from public, anon, authenticated;
drop trigger if exists providers_fill_client_code on public.providers;
create trigger providers_fill_client_code before insert or update of client_code on public.providers
  for each row execute function public.providers_fill_client_code();

-- ─── who brought whom ──────────────────────────────────────────────────────
create table if not exists public.provider_clients (
  user_id     uuid not null,
  provider_id uuid not null references public.providers(id) on delete cascade,
  code        text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, provider_id)
);
comment on table public.provider_clients is
  'Customers a business brought to EverySub itself (its QR or code). Their orders with THAT business carry 0% commission. Written only by claim_provider_client (service role).';
alter table public.provider_clients enable row level security;
-- No policies on purpose: service role only. Who is whose client decides money.

-- ─── the rate on each order ────────────────────────────────────────────────
alter table public.provider_subscriptions add column if not exists commission_pct numeric;
alter table public.food_subscriptions     add column if not exists commission_pct numeric;
alter table public.cleaning_subscriptions add column if not exists commission_pct numeric;
alter table public.rental_bookings        add column if not exists commission_pct numeric;
comment on column public.provider_subscriptions.commission_pct is 'Platform commission % for this order, stamped at creation (0 for the business''s own client). NULL = the provider''s current rate (rows from before 2026-11-06).';
comment on column public.food_subscriptions.commission_pct     is 'See provider_subscriptions.commission_pct.';
comment on column public.cleaning_subscriptions.commission_pct is 'See provider_subscriptions.commission_pct.';
comment on column public.rental_bookings.commission_pct        is 'See provider_subscriptions.commission_pct.';

-- The universal provider an order belongs to. Food and cleaning rows carry the
-- LEGACY id (cleaning sometimes only through its package).
create or replace function public.order_universal_provider(p_table text, p_row jsonb)
returns uuid language sql stable security definer set search_path = public as $$
  select case
    when p_table in ('provider_subscriptions', 'rental_bookings') then nullif(p_row->>'provider_id', '')::uuid
    when p_table = 'food_subscriptions' then (
      select p.id from public.providers p
      where p.source_service_key = 'food' and p.source_provider_id = nullif(p_row->>'provider_id', '')::uuid
      order by p.created_at limit 1)
    when p_table = 'cleaning_subscriptions' then coalesce(
      (select p.id from public.providers p
        where p.source_service_key = 'cleaning' and p.source_provider_id = nullif(p_row->>'provider_id', '')::uuid
        order by p.created_at limit 1),
      (select p.id from public.cleaning_packages k
         join public.providers p on p.source_service_key = 'cleaning' and p.source_provider_id = k.provider_id
        where k.id = p_row->>'package_id'
        order by p.created_at limit 1))
  end
$$;
revoke all on function public.order_universal_provider(text, jsonb) from public, anon, authenticated;

create or replace function public.order_commission_pct(p_provider uuid, p_user text)
returns numeric language sql stable security definer set search_path = public as $$
  select case
    when p_provider is null then null
    when p_user is not null and exists (
      select 1 from public.provider_clients c
      where c.provider_id = p_provider and c.user_id::text = p_user) then 0
    else coalesce(
      (select commission_pct from public.providers where id = p_provider),
      (select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric end
         from public.global_settings where key = 'finance_default_commission_pct'),
      10)
  end
$$;
revoke all on function public.order_commission_pct(uuid, text) from public, anon, authenticated;

create or replace function public.stamp_order_commission()
returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new);
begin
  new.commission_pct := public.order_commission_pct(
    public.order_universal_provider(tg_table_name, j), j->>'user_id');
  return new;
exception when others then
  -- Never block an order over bookkeeping: NULL reads as the provider's rate.
  new.commission_pct := null;
  return new;
end $$;
revoke all on function public.stamp_order_commission() from public, anon, authenticated;

drop trigger if exists stamp_order_commission on public.provider_subscriptions;
drop trigger if exists stamp_order_commission on public.food_subscriptions;
drop trigger if exists stamp_order_commission on public.cleaning_subscriptions;
drop trigger if exists stamp_order_commission on public.rental_bookings;
create trigger stamp_order_commission before insert on public.provider_subscriptions for each row execute function public.stamp_order_commission();
create trigger stamp_order_commission before insert on public.food_subscriptions     for each row execute function public.stamp_order_commission();
create trigger stamp_order_commission before insert on public.cleaning_subscriptions for each row execute function public.stamp_order_commission();
create trigger stamp_order_commission before insert on public.rental_bookings        for each row execute function public.stamp_order_commission();

-- ─── claiming a code ───────────────────────────────────────────────────────
-- Called by the API (service role) with the user taken from their token.
create or replace function public.claim_provider_client(p_user uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare prov record; t text; paid boolean := false; unpaid int := 0; n int;
begin
  select id, name, admin_user_id into prov from public.providers
   where upper(client_code) = upper(trim(coalesce(p_code, ''))) limit 1;
  if prov.id is null then return jsonb_build_object('claimed', false, 'reason', 'unknown-code'); end if;
  if prov.admin_user_id is not null and prov.admin_user_id::text = p_user::text then
    return jsonb_build_object('claimed', false, 'reason', 'self', 'provider', prov.name);
  end if;
  if exists (select 1 from public.provider_clients where user_id = p_user and provider_id = prov.id) then
    return jsonb_build_object('claimed', true, 'already', true, 'provider', prov.name);
  end if;

  foreach t in array array['provider_subscriptions', 'food_subscriptions', 'cleaning_subscriptions', 'rental_bookings'] loop
    execute format(
      'select exists (select 1 from public.%I o where o.user_id::text = $1 and o.payment_status = ''paid''
         and public.order_universal_provider(%L, to_jsonb(o)) = $2)', t, t)
      into paid using p_user::text, prov.id;
    if paid then
      return jsonb_build_object('claimed', false, 'reason', 'already-a-customer', 'provider', prov.name);
    end if;
  end loop;

  insert into public.provider_clients (user_id, provider_id, code) values (p_user, prov.id, upper(trim(p_code)))
  on conflict do nothing;

  -- An order started before the code landed (checkout opened, not yet paid)
  -- is theirs too.
  foreach t in array array['provider_subscriptions', 'food_subscriptions', 'cleaning_subscriptions', 'rental_bookings'] loop
    execute format(
      'update public.%I o set commission_pct = 0 where o.user_id::text = $1 and coalesce(o.payment_status, '''') <> ''paid''
         and public.order_universal_provider(%L, to_jsonb(o)) = $2', t, t)
      using p_user::text, prov.id;
    get diagnostics n = row_count; unpaid := unpaid + n;
  end loop;

  return jsonb_build_object('claimed', true, 'provider', prov.name, 'restamped', unpaid);
end $$;
revoke all on function public.claim_provider_client(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_provider_client(uuid, text) to service_role;

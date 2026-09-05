-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704192943 · direct_lives_payments

create table if not exists public.direct_lives_payments (
  id uuid primary key default gen_random_uuid(),
  memo text not null unique,
  destination_wallet text not null,
  token_mint text not null,
  amount_cents integer not null,
  amount_lives numeric(30,9) not null,
  context text,
  service_name text,
  client_name text,
  description text,
  status text not null default 'pending',
  tx_signature text,
  detected_at timestamptz,
  expires_at timestamptz not null default (now() + interval '2 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists direct_lives_payments_status_idx on public.direct_lives_payments (status, expires_at);
create index if not exists direct_lives_payments_tx_sig_idx on public.direct_lives_payments (tx_signature) where tx_signature is not null;
alter table public.direct_lives_payments enable row level security;
drop policy if exists direct_lives_payments_all on public.direct_lives_payments;
create policy direct_lives_payments_all on public.direct_lives_payments for all to public using (true) with check (true);

insert into public.global_settings (key, value)
values ('lives_direct_enabled', 'true'::jsonb)
on conflict (key) do nothing;

-- The wallet: a customer's prepaid balance in dollars, and automatic renewal
-- from it — for everyone who pays with Bitcoin (Lightning / on-chain), where no
-- processor can pull the next payment the way PayPal does.
--
--   top up  — the customer pays an ordinary invoice (Lightning, on-chain, PayPal);
--             the Edge api re-verifies it and credits the balance ONCE.
--   renew   — a daily job finds subscriptions with auto_renew on (and no PayPal
--             subscription behind them) whose period ends tomorrow or earlier,
--             takes the price from the balance and extends them exactly like a
--             PayPal renewal: a subscription_renewals row + the row's new dates,
--             so earnings, payouts and analytics read it unchanged.
--   short   — not enough on the balance: the customer is told once per period
--             what to top up, in-app and by email.
--
-- Money on a balance is the platform's liability, not revenue: it becomes
-- revenue only when spent on a renewal (subscription_renewals).
--
-- Balance = sum of wallet_ledger.amount_cents for the user. The ledger is
-- append-only. Spending goes through wallet_spend(), which locks the user's
-- ledger, checks the balance and writes the debit in one transaction — two
-- renewals can never spend the same dollars, and a repeated reference is a
-- no-op (unique). Service-role only; everything goes through the Edge api.

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  amount_cents integer not null check (amount_cents <> 0),
  kind text not null check (kind = any (array['topup','renewal','refund','adjustment'])),
  reference text not null check (char_length(reference) between 1 and 200),
  note text,
  created_at timestamptz not null default now(),
  unique (kind, reference)
);
create index if not exists wallet_ledger_user_idx on public.wallet_ledger (user_id, created_at desc);

create table if not exists public.wallet_topups (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  amount_cents integer not null check (amount_cents between 100 and 500000),
  method text not null check (method = any (array['lightning','onchain','paypal'])),
  payment_reference text not null unique,
  status text not null default 'pending' check (status = any (array['pending','paid','expired'])),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists wallet_topups_user_idx on public.wallet_topups (user_id, created_at desc);

-- "Top up to renew" is said once per subscription per period.
create table if not exists public.wallet_renewal_notices (
  subscription_key text not null,
  period_end date not null,
  created_at timestamptz not null default now(),
  primary key (subscription_key, period_end)
);

alter table public.wallet_ledger enable row level security;
alter table public.wallet_topups enable row level security;
alter table public.wallet_renewal_notices enable row level security;
revoke all on public.wallet_ledger from anon, authenticated;
revoke all on public.wallet_topups from anon, authenticated;
revoke all on public.wallet_renewal_notices from anon, authenticated;

-- Spend from a balance, atomically. Returns the new balance, or NULL when the
-- balance is short (nothing written). A reference already spent returns the
-- current balance and writes nothing.
create or replace function public.wallet_spend(p_user_id text, p_amount_cents integer, p_reference text, p_note text default null)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_balance integer;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount must be positive';
  end if;
  perform pg_advisory_xact_lock(hashtext('wallet:' || p_user_id));
  if exists (select 1 from public.wallet_ledger where kind = 'renewal' and reference = p_reference) then
    select coalesce(sum(amount_cents), 0) into v_balance from public.wallet_ledger where user_id = p_user_id;
    return v_balance;
  end if;
  select coalesce(sum(amount_cents), 0) into v_balance from public.wallet_ledger where user_id = p_user_id;
  if v_balance < p_amount_cents then
    return null;
  end if;
  insert into public.wallet_ledger (user_id, amount_cents, kind, reference, note)
  values (p_user_id, -p_amount_cents, 'renewal', p_reference, p_note);
  return v_balance - p_amount_cents;
end;
$$;
revoke all on function public.wallet_spend(text, integer, text, text) from public, anon, authenticated;
grant execute on function public.wallet_spend(text, integer, text, text) to service_role;

-- The daily renewal run: 08:00 in Roatán (14:00 UTC), production function.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'wallet_renewals_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'wallet_renewals_key',
      'x-cron-key for POST /api/cron/wallet-renewals');
  end if;
end $$;

select cron.unschedule('wallet-renewals') where exists (select 1 from cron.job where jobname = 'wallet-renewals');
select cron.schedule(
  'wallet-renewals',
  '0 14 * * *',
  $job$
    select net.http_post(
      url := 'https://igbytraidldkhhamsfdo.supabase.co/functions/v1/api/cron/wallet-renewals',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'wallet_renewals_key')
      ),
      body := '{}'::jsonb
    );
  $job$
);

comment on table public.wallet_ledger is
  'Customer prepaid balance, append-only: + top-ups, − renewals. Balance = sum per user. Spend only through wallet_spend(). Service-role only.';
comment on table public.wallet_topups is
  'Balance top-ups: an ordinary invoice, credited to wallet_ledger once verified. Service-role only.';

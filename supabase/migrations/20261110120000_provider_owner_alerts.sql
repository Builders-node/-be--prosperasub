-- Applied to production 2026-11-07 (by the owner).
-- The owner's side of the platform: invites by email, "ready for review",
-- and a morning digest of tomorrow's work.
--
-- Edge `api` (routes/owner-invites.ts, routes/provider-alerts.ts) writes all of
-- this; every column is tolerated as missing until this runs.

-- 1. Who an owner link was sent to, and whether they opened it.
alter table public.provider_owner_invites add column if not exists invited_email text;
alter table public.provider_owner_invites add column if not exists opened_at timestamptz;

-- 2. When the owner said "ready" — the admin's list sorts drafts by it.
alter table public.providers add column if not exists review_requested_at timestamptz;

-- 3. The morning digest. pg_cron calls the Edge route with a key kept in
--    Vault; the route checks it through this function, which only the
--    service role may run (SECURITY DEFINER in `public` is otherwise an
--    anon-callable API — see memory postgrest-definer-functions-are-public).
create or replace function public.cron_key_matches(p_name text, p_key text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = p_name and decrypted_secret = p_key
  );
$$;
revoke all on function public.cron_key_matches(text, text) from public, anon, authenticated;
grant execute on function public.cron_key_matches(text, text) to service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'provider_digest_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'provider_digest_key',
      'x-cron-key for POST /api/cron/provider-digest');
  end if;
end $$;

-- 07:00 in Roatán (UTC−6, no DST) = 13:00 UTC. Production function only.
select cron.unschedule('provider-digest') where exists (select 1 from cron.job where jobname = 'provider-digest');
select cron.schedule(
  'provider-digest',
  '0 13 * * *',
  $job$
    select net.http_post(
      url := 'https://igbytraidldkhhamsfdo.supabase.co/functions/v1/api/cron/provider-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'provider_digest_key')
      ),
      body := '{}'::jsonb
    );
  $job$
);

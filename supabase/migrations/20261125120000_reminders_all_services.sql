-- Reminders for every service, on a clock.
--
-- Until now a reminder existed only for a cleaning visit, and it was sent only
-- when SOMEBODY opened the app (the browser pinged Nest's /reminders/process),
-- so a quiet evening meant no reminders at all. Now:
--
--   service_occurrences — the one table of things that happen at a time (a
--     cleaning visit, a meal delivery, an hour on a court, a car pickup) — is
--     scanned every 10 minutes by pg_cron → Edge POST /cron/reminders.
--   occurrence_reminders — one row per occurrence once reminded (claimed BEFORE
--     sending, so two runs never send twice).
--   user_cleaning_preferences — despite the old name, the customer's reminder
--     settings for everything: on/off, how long before, which channel, the
--     access note; plus `reminder_services`, the service (archetype) keys to
--     remind about. NULL = every service.

alter table public.user_cleaning_preferences
  add column if not exists reminder_services text[];

comment on column public.user_cleaning_preferences.reminder_services is
  'Service (archetype) keys the customer wants reminders for. NULL = all of them. The table name is historical: these are the reminder settings for every service.';

create table if not exists public.occurrence_reminders (
  occurrence_id uuid primary key references public.service_occurrences(id) on delete cascade,
  user_id uuid not null,
  methods text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.occurrence_reminders enable row level security;
revoke all on public.occurrence_reminders from anon, authenticated;

create index if not exists service_occurrences_upcoming_idx
  on public.service_occurrences (starts_at) where status = 'scheduled';

-- The clock: every 10 minutes, the production function.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'reminders_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'reminders_key',
      'x-cron-key for POST /api/cron/reminders');
  end if;
end $$;

select cron.unschedule('reminders') where exists (select 1 from cron.job where jobname = 'reminders');
select cron.schedule(
  'reminders',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url := 'https://igbytraidldkhhamsfdo.supabase.co/functions/v1/api/cron/reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_key')
      ),
      body := '{}'::jsonb
    );
  $job$
);

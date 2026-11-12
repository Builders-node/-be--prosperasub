-- The reminders run timed out at pg_net's default 5 s (a cold Edge start plus
-- the queries, before any email is sent). Give it a minute.
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
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);

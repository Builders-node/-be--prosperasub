-- Applied 20261020120000 · cron_seed_cleaning_slots
--
-- Supabase migration, step 1 of moving the NestJS backend into Supabase.
--
-- The nightly slot grid was a Vercel cron hitting GET /cron/seed-cleaning-slots,
-- which only forwarded to seed_cleaning_slots(180) over PostgREST. The work
-- already lives in Postgres, so the schedule moves next to it: pg_cron calls
-- the function directly, with no HTTP hop and no API to be up.
--
-- 05:10 UTC, ten minutes after the Vercel cron, so the two never contend while
-- both still run. The function is idempotent (on conflict do nothing), so the
-- overlap is harmless until the Vercel entry is removed with the backend.
--
-- pg_net is enabled here too: the crons that need an Edge Function (reminders,
-- calendar, reconcile) will call one through it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('seed-cleaning-slots')
where exists (select 1 from cron.job where jobname = 'seed-cleaning-slots');

select cron.schedule(
  'seed-cleaning-slots',
  '10 5 * * *',
  $$select public.seed_cleaning_slots(180)$$
);

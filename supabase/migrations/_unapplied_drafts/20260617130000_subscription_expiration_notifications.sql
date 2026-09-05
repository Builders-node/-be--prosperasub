-- Subscription expiration reminder de-duplication ledger.
-- One row per (subscription, stage) guarantees a customer receives each reminder
-- ("2 days left", "1 day left", "expired") at most once. Written only by the
-- backend cron via the Supabase service role, mirroring cleaning_reminder_jobs.

create table if not exists public.subscription_expiration_notifications (
  id               uuid primary key default gen_random_uuid(),
  subscription_type text not null check (subscription_type in ('food', 'cleaning')),
  subscription_id   text not null,
  stage             text not null check (stage in ('2_day', '1_day', 'expired')),
  user_id           text,
  expiration_date   date,
  methods_sent      jsonb,
  sent_at           timestamptz not null default now(),
  unique (subscription_type, subscription_id, stage)
);

create index if not exists idx_sub_exp_notif_lookup
  on public.subscription_expiration_notifications (subscription_type, subscription_id);

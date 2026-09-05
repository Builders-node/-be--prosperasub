-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260617224819 · subscription_expiration_notifications

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

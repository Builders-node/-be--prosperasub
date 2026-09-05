-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260818220203 · provider_tips_unified

-- One tips table for every service, so a tip is the same thing whatever was
-- bought. Food and cleaning had their own (food_tips keyed by subscription,
-- cleaning_tips by booking); beach and universal had none. This is the single
-- table the unified TipPanel writes to, keyed by the purchase it belongs to.
create table if not exists provider_tips (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  provider_id uuid,               -- attribution; nullable where a service has no direct provider id
  subscription_ref text not null, -- the purchase this tip is for (any service's id)
  service text not null,          -- food | cleaning | beach | plan
  customer_name text,
  amount_cents integer not null check (amount_cents > 0),
  message text,
  payment_status text not null default 'pending',
  payment_method text,
  payment_reference text,
  created_at timestamptz not null default now()
);

create index if not exists provider_tips_ref_idx on provider_tips (subscription_ref, service);

-- Permissive, like food_tips/cleaning_tips: the browser records a tip with the
-- anon key at payment time. Same trade-off the other service tables carry.
alter table provider_tips enable row level security;
drop policy if exists provider_tips_all on provider_tips;
create policy provider_tips_all on provider_tips for all to public using (true) with check (true);

comment on table provider_tips is
  'Unified tips across all services (food/cleaning/beach/plan), written by the TipPanel in the My Subs purchase sheet. Legacy food_tips/cleaning_tips are kept for history.';

-- Five tables the browser never touches were readable and writable by anyone
-- holding the anon key. Each of them is written only by NestJS with the
-- service-role key, which bypasses RLS — so enabling it with no policies at all
-- makes them service-role-only, the same shape service_occurrences already has.
--
-- Verified before applying: zero references in frontend/src; the four backend
-- services that use them read SUPABASE_SERVICE_ROLE_KEY.

alter table public.user_sessions                         enable row level security;
alter table public.user_cleaning_preferences             enable row level security;
alter table public.cleaning_reminder_jobs                enable row level security;
alter table public.lightning_auth_challenges             enable row level security;
alter table public.subscription_expiration_notifications enable row level security;

comment on table public.user_sessions is
  'Service-role only. Vestigial: refresh_token_hash is read nowhere in backend/src — the only reference left is admin/data-reset-plan.ts.';

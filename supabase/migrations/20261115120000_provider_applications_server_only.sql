-- provider_applications: service-role only.
--
-- It was FOR ALL TO public USING (true): the anon key could read every
-- applicant's email and phone, rewrite or delete other people's applications
-- and file one under someone else's user_id. Every reader and writer now goes
-- through the Edge API (routes/provider-applications.ts).
--
-- APPLY ONLY AFTER that code is on production — the old frontend reads and
-- writes this table directly and would stop working.
drop policy if exists provider_applications_all on public.provider_applications;
alter table public.provider_applications enable row level security;
revoke all on public.provider_applications from anon, authenticated;
comment on table public.provider_applications is
  'Applications to sell. Service-role only — Edge routes/provider-applications.ts.';

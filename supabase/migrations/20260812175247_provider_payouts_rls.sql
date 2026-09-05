-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812175247 · provider_payouts_rls

-- RLS on with no policies at all: PostgREST with the anon key sees nothing and
-- can write nothing. Every other config table here is permissive because the
-- admin CRUDs write from the browser; a money ledger is exactly the table that
-- must not be, so reads and writes go through NestJS with the service role,
-- which bypasses RLS.
alter table public.provider_payouts enable row level security;

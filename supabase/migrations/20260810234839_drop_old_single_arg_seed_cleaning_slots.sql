-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810234839 · drop_old_single_arg_seed_cleaning_slots

-- CREATE OR REPLACE with an added parameter makes an OVERLOAD, not a
-- replacement. Both signatures existed, so `seed_cleaning_slots(180)` became
-- ambiguous — and the backend cron calls the RPC with p_days_ahead alone.
-- Left as it was, the nightly grid top-up would have failed outright, or
-- resolved to the old body that still hard-codes the four 105-minute pairs and
-- knows nothing about providers.

drop function if exists public.seed_cleaning_slots(integer);

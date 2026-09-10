-- One catch-up for what the missing cron never made.
--
-- Exactly what the "Schedule ahead" button does, and exactly what the trigger
-- installed alongside this will do from now on — `on conflict do nothing`, so
-- it adds only the days that are absent and touches nothing already there.
--
-- Dry-run first, in a transaction that was rolled back: 10 future food
-- occurrences existed, one run produced 66 more.

select public.generate_food_occurrences(21);

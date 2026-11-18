-- Meals for the days ahead are created every day, not when someone presses a
-- button.
--
-- generate_food_occurrences(days_ahead) turns every active, paid meal
-- subscription into one service_occurrences row per meal per delivery day.
-- Nothing ran it on a schedule — only the workspace's "generate" endpoint — so
-- a customer who renewed (Brennan Morris, 17 Nov: paid Nov 19–26) had no meals
-- from the 19th on, and the 07:00 provider digest, which reads these rows,
-- would not have listed him. It is idempotent (on conflict do nothing).
--
-- 05:20 UTC = 23:20 Roatán the night before, ahead of the 07:00 digest.
-- Safe to run twice.

do $$ begin
  perform cron.unschedule('food-occurrences');
exception when others then null; end $$;

select cron.schedule('food-occurrences', '20 5 * * *', $$select public.generate_food_occurrences(21)$$);

-- And once now, for the weeks already missing.
select public.generate_food_occurrences(21);

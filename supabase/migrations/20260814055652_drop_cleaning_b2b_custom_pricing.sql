-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814055652 · drop_cleaning_b2b_custom_pricing

-- The half-built B2B pricing machinery for cleaning: per-client custom plans,
-- their recurring schedules and their checklist templates. All three were
-- empty — 0 rows each — and the only writer was an RPC shim in the frontend
-- data wrapper that nothing called.
--
-- Deliberately KEPT:
--   • `cleaning_clients` — 82 bookings, 34 completion reports and 2
--     subscriptions reference it, and the booking list shows the company name
--     from it. Removing it would blank the customer on live rows.
--   • `cleaning_plan_client_assignments` — 2 live rows linking a real client
--     to two PRIVATE packages. That is plan visibility, not custom pricing.
--     Its `custom_price_cents` column is the custom-pricing part, and it was
--     null on both rows, so only the column goes.

alter table cleaning_bookings
  drop column if exists custom_plan_id,
  drop column if exists recurring_schedule_id,
  drop column if exists checklist_template_id;

alter table cleaning_completion_reports drop column if exists custom_plan_id;

alter table cleaning_plan_client_assignments drop column if exists custom_price_cents;

drop table if exists cleaning_checklist_templates;
drop table if exists cleaning_recurring_schedules;
drop table if exists cleaning_custom_plans;

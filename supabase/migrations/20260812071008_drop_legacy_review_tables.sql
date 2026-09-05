-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812071008 · drop_legacy_review_tables

-- Three tables held "a rating", and only one of them was ever displayed.
--
--   cleaning_reviews  — written by the visit dialog, read by nobody
--   food_reviews      — written by the food panel AND by the restaurant page,
--                       which was therefore the only screen that could see its
--                       own reviews; the provider page never could
--   provider_reviews  — what the provider page and the reviews block read
--
-- A customer who rated their restaurant or their cleaning watched the stars
-- save and then appear nowhere anyone else would look. Every rating path now
-- writes provider_reviews, which is a superset of the other two
-- (provider_id, user_id, customer_name, rating, comment, service,
-- subscription_id).
--
-- Both dropped tables were empty when this ran, so nothing is being discarded.
-- Dropping rather than leaving them: an empty table with an obvious name is how
-- the next rating feature gets built against the wrong one again.

drop table if exists public.cleaning_reviews;
drop table if exists public.food_reviews;

comment on table public.provider_reviews is
  'Every rating on the platform. One row per (provider_id, user_id) — upserted, so a customer has one standing review per business. `service` records which flow it came from. Replaced cleaning_reviews and food_reviews on 2026-08-12.';

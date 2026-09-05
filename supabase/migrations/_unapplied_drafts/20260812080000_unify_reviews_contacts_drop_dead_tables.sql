-- Three unification passes over the customer-facing surface.
-- Applied to production on 2026-08-12 via the Supabase MCP and recorded here.

-- ── 1. Two of the six checkouts asked for nothing but money ─────────────────
-- Cleaning, food, the cart and a car booking all collect a WhatsApp number and
-- a note. The beach membership and the universal plan checkout collected
-- neither — so somebody buying a membership had no way to say "I'm coming with
-- a child" and the provider had no way to reach them, while the same person
-- buying a cleaning got both fields.
--
-- Same column names as cleaning_subscriptions and food_subscriptions rather
-- than a new spelling: every provider-facing list, export and reminder already
-- knows customer_whatsapp and notes.

alter table beach_club_subscriptions add column if not exists customer_whatsapp text;
alter table beach_club_subscriptions add column if not exists notes text;
alter table provider_subscriptions   add column if not exists customer_whatsapp text;
alter table provider_subscriptions   add column if not exists notes text;

comment on column beach_club_subscriptions.customer_whatsapp is
  'How the provider reaches this customer. Same field as cleaning_subscriptions.customer_whatsapp.';
comment on column beach_club_subscriptions.notes is
  'Anything the customer wanted the provider to know at checkout.';
comment on column provider_subscriptions.customer_whatsapp is
  'How the provider reaches this customer. Same field as cleaning_subscriptions.customer_whatsapp.';
comment on column provider_subscriptions.notes is
  'Anything the customer wanted the provider to know at checkout.';

-- ── 2. Three review tables, one of them displayed ───────────────────────────
--   cleaning_reviews  — written by the visit dialog, read by nobody
--   food_reviews      — written by the food panel AND the restaurant page, so
--                       that page was the only screen that could see its own
--                       reviews; the provider page never could
--   provider_reviews  — what the provider page and the reviews block read
--
-- A customer who rated their restaurant or their cleaning watched the stars
-- save and then appear nowhere anyone else would look. Every rating path now
-- writes provider_reviews, which is a superset of the other two.
--
-- Both dropped tables were empty when this ran. Dropping rather than leaving
-- them: an empty table with an obvious name is how the next rating feature
-- gets built against the wrong one again.

drop table if exists public.cleaning_reviews;
drop table if exists public.food_reviews;

-- NOTE: get_food_catalog() aggregated ratings from food_reviews. plpgsql does
-- not resolve table names until run time, so this drop succeeded and the food
-- listing started failing with 42P01 in production. Fixed in
-- 20260812093000_get_food_catalog_reads_provider_reviews.sql — grep the
-- database's function bodies, not just the app source, before dropping a table.

comment on table public.provider_reviews is
  'Every rating on the platform. One row per (provider_id, user_id) — upserted, so a customer has one standing review per business. `service` records which flow it came from. Replaced cleaning_reviews and food_reviews on 2026-08-12.';

-- ── 3. `favorites` was never wired up ───────────────────────────────────────
-- Zero rows, zero references anywhere in frontend/src or backend/src, no
-- foreign keys pointing at it and no view reading it — a shelf put up for a
-- feature that was never built. Its columns still name the shape it was meant
-- for and never grew out of: restaurant_id / plan_id, from when the platform
-- was only the food service.
--
-- If favourites are wanted later, the shape to build is polymorphic against
-- providers.id + provider_plans.id — the ids everything else uses now.

drop table if exists public.favorites;

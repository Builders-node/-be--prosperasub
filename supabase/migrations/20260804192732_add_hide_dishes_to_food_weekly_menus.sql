-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804192732 · add_hide_dishes_to_food_weekly_menus

-- "Surprise menu": the restaurant publishes a week so customers can see WHICH
-- meals they get each day (breakfast / lunch / dinner) without revealing the
-- dishes. Per menu rather than per restaurant, so a kitchen can run a surprise
-- week and a published week side by side.
alter table public.food_weekly_menus
  add column if not exists hide_dishes boolean not null default false;

comment on column public.food_weekly_menus.hide_dishes is
  'When true, customer-facing surfaces show only the meal types scheduled per day — never meal_name, meal_description, image_url or calories. Redaction happens where the rows are read, so hidden names are not sent to the client at all.';

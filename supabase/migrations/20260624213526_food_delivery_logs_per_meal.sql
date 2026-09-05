-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260624213526 · food_delivery_logs_per_meal

alter table public.food_delivery_logs
  add column if not exists meal_type text not null default 'meal';

alter table public.food_delivery_logs
  drop constraint if exists food_delivery_logs_subscription_id_delivery_date_key;

-- unique per subscription + date + meal so each meal is tracked independently
create unique index if not exists food_delivery_logs_sub_date_meal_key
  on public.food_delivery_logs (subscription_id, delivery_date, meal_type);

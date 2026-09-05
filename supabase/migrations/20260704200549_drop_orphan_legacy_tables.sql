-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704200549 · drop_orphan_legacy_tables


DROP TABLE IF EXISTS public.daily_meal_choices CASCADE;
DROP TABLE IF EXISTS public.menu_items CASCADE;
DROP TABLE IF EXISTS public.subscriptions CASCADE;
DROP TABLE IF EXISTS public.weekly_menus CASCADE;
DROP TABLE IF EXISTS public.subscription_plans CASCADE;
DROP TABLE IF EXISTS public.restaurant_settings CASCADE;
DROP TABLE IF EXISTS public.restaurants CASCADE;
DROP TABLE IF EXISTS public.beach_club_inquiries CASCADE;
DROP TABLE IF EXISTS public.direct_lives_payments CASCADE;
DELETE FROM public.global_settings WHERE key = 'lives_direct_enabled';

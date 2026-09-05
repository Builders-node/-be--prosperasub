-- Remove the legacy restaurant/food/order module while preserving auth, admin,
-- cleaning, payment checkout sessions, notifications, and migration history.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

SELECT pg_advisory_xact_lock(hashtext('remove_restaurant_food_module'));

DO $$
DECLARE
  fn record;
  function_names text[] := ARRAY[
    'claim_order_for_delivery',
    'create_menu_item_by_pubkey',
    'create_menu_item_for_solana',
    'create_order_by_pubkey',
    'create_product_by_pubkey',
    'create_restaurant_for_solana_user',
    'create_restaurant_for_user',
    'create_subscription_by_pubkey',
    'create_subscription_for_solana',
    'create_subscription_plan_by_pubkey',
    'create_subscription_plan_for_solana',
    'create_weekly_menu_by_pubkey',
    'create_weekly_menu_for_solana',
    'delete_menu_item_by_pubkey',
    'delete_menu_item_for_solana',
    'delete_product_by_pubkey',
    'delete_subscription_plan_by_pubkey',
    'delete_subscription_plan_for_solana',
    'generate_meal_choices_for_subscription',
    'get_available_orders_for_driver',
    'get_daily_meal_choices_by_pubkey',
    'get_driver_delivery_history',
    'get_driver_orders_by_pubkey',
    'get_products_by_restaurant',
    'get_restaurant_orders_by_pubkey',
    'get_restaurant_settings',
    'get_restaurant_wallet_for_solana',
    'get_solana_user_restaurant_id',
    'get_subscription_detail_by_pubkey',
    'get_subscription_plans_by_pubkey',
    'get_subscription_plans_by_restaurant',
    'get_subscription_plans_for_solana',
    'get_user_profile_for_solana',
    'get_user_orders_by_pubkey',
    'get_user_restaurant_id',
    'get_user_restaurants',
    'get_weekly_menus_by_pubkey',
    'get_weekly_menus_by_restaurant',
    'get_weekly_menus_for_solana',
    'is_restaurant_admin',
    'link_solana_user_to_restaurant',
    'link_user_to_restaurant',
    'lock_overdue_meal_choices',
    'update_menu_item_by_pubkey',
    'update_menu_item_for_solana',
    'update_menu_status_by_pubkey',
    'update_menu_status_for_solana',
    'update_order_status_by_driver',
    'update_order_status_by_pubkey',
    'update_product_by_pubkey',
    'update_subscription_plan_by_pubkey',
    'update_subscription_plan_for_solana',
    'upsert_restaurant_settings',
    'upsert_restaurant_wallet_for_solana',
    'upsert_user_profile_for_solana'
  ];
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(function_names)
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', fn.signature);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Restaurant admins can update their own restaurant_id" ON public.users;
DROP POLICY IF EXISTS "Restaurant admins can view subscribers" ON public.users;
DROP POLICY IF EXISTS "Restaurant admins can view their subscribers" ON public.users;

DELETE FROM public.user_roles
WHERE role::text IN ('restaurant_admin', 'driver');

ALTER TABLE IF EXISTS public.users
  DROP CONSTRAINT IF EXISTS users_restaurant_id_fkey,
  DROP COLUMN IF EXISTS restaurant_id;

ALTER TABLE IF EXISTS public.user_profiles
  DROP COLUMN IF EXISTS food_preferences,
  DROP COLUMN IF EXISTS default_meal_type,
  DROP COLUMN IF EXISTS default_delivery_address;

DROP TABLE IF EXISTS public.daily_meal_choices CASCADE;
DROP TABLE IF EXISTS public.order_items CASCADE;
DROP TABLE IF EXISTS public.payments CASCADE;
DROP TABLE IF EXISTS public.orders CASCADE;
DROP TABLE IF EXISTS public.products CASCADE;
DROP TABLE IF EXISTS public.favorites CASCADE;
DROP TABLE IF EXISTS public.menu_items CASCADE;
DROP TABLE IF EXISTS public.weekly_menus CASCADE;
DROP TABLE IF EXISTS public.subscriptions CASCADE;
DROP TABLE IF EXISTS public.subscription_plans CASCADE;
DROP TABLE IF EXISTS public.restaurant_wallets CASCADE;
DROP TABLE IF EXISTS public.restaurant_settings CASCADE;
DROP TABLE IF EXISTS public.restaurant_admins CASCADE;
DROP TABLE IF EXISTS public.restaurants CASCADE;

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DELETE FROM storage.objects WHERE bucket_id = 'menu-images';
  END IF;

  IF to_regclass('storage.buckets') IS NOT NULL THEN
    DELETE FROM storage.buckets WHERE id = 'menu-images';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'app_role'
      AND e.enumlabel IN ('restaurant_admin', 'driver')
  ) THEN
    ALTER TYPE public.app_role RENAME TO app_role_old;
    CREATE TYPE public.app_role AS ENUM ('super_admin', 'user');
    ALTER TABLE public.user_roles
      ALTER COLUMN role TYPE public.app_role
      USING role::text::public.app_role;
    DROP TYPE public.app_role_old;
  END IF;
END $$;

DROP TYPE IF EXISTS public.menu_category CASCADE;
DROP TYPE IF EXISTS public.menu_status CASCADE;
DROP TYPE IF EXISTS public.meal_choice CASCADE;
DROP TYPE IF EXISTS public.meal_status CASCADE;
DROP TYPE IF EXISTS public.meal_type CASCADE;
DROP TYPE IF EXISTS public.meal_type_slot CASCADE;
DROP TYPE IF EXISTS public.order_status CASCADE;
DROP TYPE IF EXISTS public.payment_type CASCADE;
DROP TYPE IF EXISTS public.lightning_wallet_type CASCADE;

ALTER TABLE IF EXISTS public.global_settings
  DROP COLUMN IF EXISTS daily_choice_cutoff_hours;

COMMIT;

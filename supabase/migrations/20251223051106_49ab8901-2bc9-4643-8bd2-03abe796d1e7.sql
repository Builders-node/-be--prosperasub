-- Step 1: Update get_current_user_id() to remove Solana logic (Lightning-only)
CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pubkey TEXT;
  v_user_id UUID;
BEGIN
  -- Check for Lightning pubkey
  v_pubkey := current_setting('app.current_pubkey', true);
  IF v_pubkey IS NOT NULL AND v_pubkey != '' THEN
    SELECT id INTO v_user_id FROM public.users WHERE lightning_pubkey = v_pubkey;
    RETURN v_user_id;
  END IF;
  
  RETURN NULL;
END;
$function$;

-- Step 2: Update any existing 'solana' payment methods to 'lightning'
UPDATE public.payments SET payment_method = 'lightning' WHERE payment_method = 'solana';
UPDATE public.subscriptions SET payment_method = 'lightning' WHERE payment_method = 'solana';

-- Step 3: Save the function definition for create_subscription_by_pubkey
-- Then drop it to remove dependency on payment_method enum

-- Drop the function that depends on payment_method
DROP FUNCTION IF EXISTS public.create_subscription_by_pubkey(text, uuid, uuid, date, date, integer, integer, text);

-- Step 4: Remove default constraints on payment_method columns
ALTER TABLE public.payments ALTER COLUMN payment_method DROP DEFAULT;
ALTER TABLE public.subscriptions ALTER COLUMN payment_method DROP DEFAULT;

-- Step 5: Convert columns to text temporarily
ALTER TABLE public.payments ALTER COLUMN payment_method TYPE text USING payment_method::text;
ALTER TABLE public.subscriptions ALTER COLUMN payment_method TYPE text USING payment_method::text;

-- Step 6: Drop the old enum
DROP TYPE IF EXISTS payment_method;

-- Step 7: Create the new enum without 'solana'
CREATE TYPE payment_method AS ENUM ('lightning');

-- Step 8: Convert columns back to the new enum
ALTER TABLE public.payments ALTER COLUMN payment_method TYPE payment_method USING payment_method::payment_method;
ALTER TABLE public.subscriptions ALTER COLUMN payment_method TYPE payment_method USING payment_method::payment_method;

-- Step 9: Set defaults
ALTER TABLE public.payments ALTER COLUMN payment_method SET DEFAULT 'lightning'::payment_method;
ALTER TABLE public.subscriptions ALTER COLUMN payment_method SET DEFAULT 'lightning'::payment_method;

-- Step 10: Recreate the function without payment_method in return type
CREATE OR REPLACE FUNCTION public.create_subscription_by_pubkey(
  p_pubkey text, 
  p_restaurant_id uuid, 
  p_plan_id uuid, 
  p_start_date date, 
  p_end_date date, 
  p_duration_weeks integer, 
  p_total_price_sats integer, 
  p_payment_reference text
)
RETURNS TABLE(
  id uuid, 
  user_id uuid, 
  restaurant_id uuid, 
  plan_id uuid, 
  start_date date, 
  end_date date, 
  duration_weeks integer, 
  total_price_sats integer, 
  payment_reference text, 
  payment_status payment_status, 
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_subscription_id UUID;
BEGIN
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for pubkey';
  END IF;
  
  INSERT INTO public.subscriptions (
    user_id, restaurant_id, plan_id, start_date, end_date,
    duration_weeks, total_price_sats,
    payment_method, payment_reference, payment_status, is_active
  )
  VALUES (
    v_user_id, p_restaurant_id, p_plan_id, p_start_date, p_end_date,
    p_duration_weeks, p_total_price_sats,
    'lightning', p_payment_reference, 'paid', true
  )
  RETURNING subscriptions.id INTO v_subscription_id;
  
  PERFORM public.generate_meal_choices_for_subscription(v_subscription_id);
  
  RETURN QUERY
  SELECT 
    s.id, s.user_id, s.restaurant_id, s.plan_id, s.start_date, s.end_date,
    s.duration_weeks, s.total_price_sats,
    s.payment_reference, s.payment_status, s.is_active
  FROM public.subscriptions s
  WHERE s.id = v_subscription_id;
END;
$function$;
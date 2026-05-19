-- Create a security definer function to create subscriptions for Solana users
CREATE OR REPLACE FUNCTION public.create_subscription_for_solana(
  p_wallet_address text,
  p_restaurant_id uuid,
  p_plan_id uuid,
  p_start_date date,
  p_end_date date,
  p_duration_weeks integer,
  p_total_price_sats integer,
  p_total_price_sol numeric,
  p_payment_method payment_method,
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
  total_price_sol numeric,
  payment_method payment_method,
  payment_reference text,
  payment_status payment_status,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_subscription_id UUID;
BEGIN
  -- Get user_id from wallet address
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.email = p_wallet_address || '@solana.wallet';
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for wallet';
  END IF;
  
  -- Insert subscription
  INSERT INTO public.subscriptions (
    user_id, restaurant_id, plan_id, start_date, end_date,
    duration_weeks, total_price_sats, total_price_sol,
    payment_method, payment_reference, payment_status, is_active
  )
  VALUES (
    v_user_id, p_restaurant_id, p_plan_id, p_start_date, p_end_date,
    p_duration_weeks, p_total_price_sats, p_total_price_sol,
    p_payment_method, p_payment_reference, 'paid', true
  )
  RETURNING subscriptions.id INTO v_subscription_id;
  
  -- Generate meal choices for the subscription
  PERFORM public.generate_meal_choices_for_subscription(v_subscription_id);
  
  RETURN QUERY
  SELECT 
    s.id, s.user_id, s.restaurant_id, s.plan_id, s.start_date, s.end_date,
    s.duration_weeks, s.total_price_sats, s.total_price_sol,
    s.payment_method, s.payment_reference, s.payment_status, s.is_active
  FROM public.subscriptions s
  WHERE s.id = v_subscription_id;
END;
$$;
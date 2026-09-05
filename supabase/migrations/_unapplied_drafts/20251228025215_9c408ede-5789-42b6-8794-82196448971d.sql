-- Add meal_type column to daily_meal_choices to support per-meal choices
ALTER TABLE public.daily_meal_choices 
ADD COLUMN meal_type public.meal_type_slot NOT NULL DEFAULT 'lunch';

-- Drop the existing unique constraint if it exists
ALTER TABLE public.daily_meal_choices 
DROP CONSTRAINT IF EXISTS daily_meal_choices_subscription_id_date_key;

-- Create a new unique constraint that includes meal_type
ALTER TABLE public.daily_meal_choices 
ADD CONSTRAINT daily_meal_choices_subscription_date_meal_unique 
UNIQUE (subscription_id, date, meal_type);

-- Update the generate_meal_choices_for_subscription function to create choices per meal slot
CREATE OR REPLACE FUNCTION public.generate_meal_choices_for_subscription(p_subscription_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_start_date DATE;
  v_end_date DATE;
  v_current_date DATE;
  v_meal_types text[] := ARRAY['breakfast', 'lunch', 'dinner'];
  v_meal_type text;
BEGIN
  SELECT start_date, end_date INTO v_start_date, v_end_date
  FROM public.subscriptions WHERE id = p_subscription_id;
  
  v_current_date := v_start_date;
  WHILE v_current_date <= v_end_date LOOP
    FOREACH v_meal_type IN ARRAY v_meal_types LOOP
      INSERT INTO public.daily_meal_choices (subscription_id, date, meal_type, choice, locked, status)
      VALUES (p_subscription_id, v_current_date, v_meal_type::meal_type_slot, NULL, false, 'pending')
      ON CONFLICT (subscription_id, date, meal_type) DO NOTHING;
    END LOOP;
    v_current_date := v_current_date + 1;
  END LOOP;
END;
$$;
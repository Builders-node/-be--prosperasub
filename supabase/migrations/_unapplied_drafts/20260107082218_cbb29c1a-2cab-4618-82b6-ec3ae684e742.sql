-- Drop the old unique constraint that blocks multiple categories per week
ALTER TABLE public.weekly_menus 
DROP CONSTRAINT IF EXISTS weekly_menus_restaurant_id_week_start_date_key;
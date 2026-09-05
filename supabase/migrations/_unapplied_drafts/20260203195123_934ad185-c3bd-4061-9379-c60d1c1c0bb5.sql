-- Drop the old policy that uses legacy users.restaurant_id
DROP POLICY IF EXISTS "Restaurant admins can view and update meal choices for their re" ON public.daily_meal_choices;

-- Create new policy that uses restaurant_admins table
CREATE POLICY "Restaurant admins can view and update meal choices"
ON public.daily_meal_choices
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM subscriptions s
    JOIN restaurant_admins ra ON ra.restaurant_id = s.restaurant_id
    WHERE s.id = daily_meal_choices.subscription_id 
      AND ra.user_id = get_current_user_id()
  )
  OR
  EXISTS (
    SELECT 1 FROM subscriptions s
    JOIN users u ON u.restaurant_id = s.restaurant_id
    WHERE s.id = daily_meal_choices.subscription_id 
      AND u.id = get_current_user_id()
  )
);
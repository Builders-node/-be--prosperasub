-- Add INSERT policy for restaurant admins to create restaurants
CREATE POLICY "Restaurant admins can create restaurants"
ON public.restaurants
FOR INSERT
WITH CHECK (
  has_role(get_current_user_id(), 'restaurant_admin'::app_role)
  OR has_role(get_current_user_id(), 'super_admin'::app_role)
);
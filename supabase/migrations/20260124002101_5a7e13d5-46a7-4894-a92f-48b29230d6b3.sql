-- Add policy for users to update their own restaurant_id when they have restaurant_admin role
CREATE POLICY "Restaurant admins can update their own restaurant_id"
ON public.users
FOR UPDATE
USING (
  id = get_current_user_id() 
  AND has_role(get_current_user_id(), 'restaurant_admin'::app_role)
)
WITH CHECK (
  id = get_current_user_id()
  AND has_role(get_current_user_id(), 'restaurant_admin'::app_role)
);
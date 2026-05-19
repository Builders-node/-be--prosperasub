-- Add policy for restaurant admins to view subscriber user info
CREATE POLICY "Restaurant admins can view their subscribers"
ON public.users FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM subscriptions s
    JOIN restaurant_admins ra ON ra.restaurant_id = s.restaurant_id
    WHERE s.user_id = users.id AND ra.user_id = auth.uid()
  )
);
-- Drop the outdated RLS policy that only checks users.restaurant_id
DROP POLICY IF EXISTS "Restaurant admins can view subscriptions to their restaurant" ON public.subscriptions;

-- Create new policy that also checks restaurant_admins table
CREATE POLICY "Restaurant admins can view subscriptions to their restaurant"
ON public.subscriptions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.restaurant_id = subscriptions.restaurant_id
      AND ra.user_id = get_current_user_id()
  )
  OR
  EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = get_current_user_id()
      AND u.restaurant_id = subscriptions.restaurant_id
  )
);

-- Also allow restaurant admins to update subscriptions (for payment confirmation)
DROP POLICY IF EXISTS "Restaurant admins can update subscriptions" ON public.subscriptions;

CREATE POLICY "Restaurant admins can update subscriptions"
ON public.subscriptions
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.restaurant_id = subscriptions.restaurant_id
      AND ra.user_id = get_current_user_id()
  )
  OR
  EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = get_current_user_id()
      AND u.restaurant_id = subscriptions.restaurant_id
  )
);
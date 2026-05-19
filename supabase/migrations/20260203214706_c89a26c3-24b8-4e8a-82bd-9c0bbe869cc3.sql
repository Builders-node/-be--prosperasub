-- First drop the problematic policy that causes recursion via subscriptions join
DROP POLICY IF EXISTS "Restaurant admins can view subscribers" ON public.users;

-- The subscription table policies use get_current_user_id() which queries users table
-- We need to fix those policies too to break the recursion chain

-- Drop subscription policies that cause recursion
DROP POLICY IF EXISTS "Super admins can view all subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Restaurant admins can view subscriptions to their restaurant" ON public.subscriptions;
DROP POLICY IF EXISTS "Restaurant admins can update subscriptions" ON public.subscriptions;

-- Recreate subscription policies using auth.uid() directly instead of get_current_user_id()
CREATE POLICY "Super admins can view all subscriptions"
ON public.subscriptions FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur 
    WHERE ur.user_id = auth.uid() AND ur.role = 'super_admin'
  )
);

CREATE POLICY "Restaurant admins can view subscriptions to their restaurant"
ON public.subscriptions FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.restaurant_id = subscriptions.restaurant_id AND ra.user_id = auth.uid()
  )
);

CREATE POLICY "Restaurant admins can update subscriptions"
ON public.subscriptions FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM restaurant_admins ra
    WHERE ra.restaurant_id = subscriptions.restaurant_id AND ra.user_id = auth.uid()
  )
);

-- Fix user subscription policies too
DROP POLICY IF EXISTS "Users can view their own subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Users can create their own subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Users can update their own subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Users can delete their own subscriptions" ON public.subscriptions;

CREATE POLICY "Users can view their own subscriptions"
ON public.subscriptions FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Users can create their own subscriptions"
ON public.subscriptions FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own subscriptions"
ON public.subscriptions FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own subscriptions"
ON public.subscriptions FOR DELETE TO authenticated
USING (user_id = auth.uid());
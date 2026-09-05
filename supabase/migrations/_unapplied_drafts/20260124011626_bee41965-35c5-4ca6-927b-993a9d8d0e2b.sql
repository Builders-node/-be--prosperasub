-- Fix infinite recursion in RLS policy for restaurant_admins
-- The previous policy referenced restaurant_admins within itself, causing PostgREST 500 errors.

DROP POLICY IF EXISTS "Restaurant owners can manage their restaurant admins" ON public.restaurant_admins;

-- Allow users to insert/update/delete ONLY their own membership rows.
-- Super admins retain full access via the existing policy.
CREATE POLICY "Users can manage their own admin membership"
ON public.restaurant_admins
FOR ALL
TO public
USING (user_id = get_current_user_id())
WITH CHECK (user_id = get_current_user_id());

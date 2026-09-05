-- Add a direct policy for authenticated users to view their own data
-- This avoids recursion by using auth.uid() directly instead of get_current_user_id()
CREATE POLICY "Authenticated users can view own profile"
ON public.users
FOR SELECT
TO authenticated
USING (id = auth.uid());
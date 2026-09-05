-- Add RLS policy for super_admins to view all users
CREATE POLICY "Super admins can view all users"
ON public.users
FOR SELECT
USING (has_role(get_current_user_id(), 'super_admin'::app_role));
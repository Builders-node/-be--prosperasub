-- Add policy for Solana users to update their own record
CREATE POLICY "Solana users can update their own profile"
ON public.users
FOR UPDATE
USING (id = get_current_user_id());
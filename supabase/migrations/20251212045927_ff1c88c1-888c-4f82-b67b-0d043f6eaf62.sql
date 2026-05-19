-- Add policy to allow Lightning users to view their own roles
CREATE POLICY "Lightning users can view their own roles"
ON public.user_roles
FOR SELECT
USING (
  user_id = (
    SELECT id FROM public.users 
    WHERE lightning_pubkey = current_setting('app.current_pubkey', true)
  )
);
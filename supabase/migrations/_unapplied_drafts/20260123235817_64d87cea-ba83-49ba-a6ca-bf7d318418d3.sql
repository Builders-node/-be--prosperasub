-- Create a function to auto-assign super_admin role for specific emails
CREATE OR REPLACE FUNCTION public.assign_super_admin_on_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Check if the email is in the super admin list
  IF NEW.email = 'frorex.studio@gmail.com' THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on users table for when a new user signs up
DROP TRIGGER IF EXISTS on_user_created_assign_admin ON public.users;
CREATE TRIGGER on_user_created_assign_admin
  AFTER INSERT ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_super_admin_on_signup();
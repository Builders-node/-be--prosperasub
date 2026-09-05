-- Drop ALL existing problematic policies on users table
DROP POLICY IF EXISTS "Users can view their own data" ON public.users;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.users;
DROP POLICY IF EXISTS "Solana users can update their own profile" ON public.users;
DROP POLICY IF EXISTS "Super admins can view all users" ON public.users;
DROP POLICY IF EXISTS "Restaurant admins can view their subscribers" ON public.users;
DROP POLICY IF EXISTS "Restaurant admins can update their own restaurant_id" ON public.users;
DROP POLICY IF EXISTS "Authenticated users can view own profile" ON public.users;

-- Create simple, non-recursive policies using ONLY auth.uid() and current_setting
-- 1. Allow authenticated users to view their own profile (by auth.uid)
CREATE POLICY "Auth users can view own profile"
ON public.users FOR SELECT TO authenticated
USING (id = auth.uid());

-- 2. Allow Lightning users to view their own profile (by session variable)
CREATE POLICY "Lightning users can view own profile"
ON public.users FOR SELECT
USING (lightning_pubkey = current_setting('app.current_pubkey', true));

-- 3. Allow authenticated users to update their own profile
CREATE POLICY "Auth users can update own profile"
ON public.users FOR UPDATE TO authenticated
USING (id = auth.uid());

-- 4. Allow Lightning users to update their own profile
CREATE POLICY "Lightning users can update own profile"
ON public.users FOR UPDATE
USING (lightning_pubkey = current_setting('app.current_pubkey', true));

-- 5. Super admins can view all users - use a subquery that doesn't reference users table
CREATE POLICY "Super admins can view all users"
ON public.users FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur 
    WHERE ur.user_id = auth.uid() AND ur.role = 'super_admin'
  )
);

-- 6. Restaurant admins can view their subscribers - reference subscriptions, not users
CREATE POLICY "Restaurant admins can view subscribers"
ON public.users FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM subscriptions s
    JOIN restaurant_admins ra ON ra.restaurant_id = s.restaurant_id
    WHERE s.user_id = users.id AND ra.user_id = auth.uid()
  )
);

-- 7. Keep insert policy
DROP POLICY IF EXISTS "Allow insert for authenticated sessions" ON public.users;
CREATE POLICY "Allow insert for new users"
ON public.users FOR INSERT
WITH CHECK (true);
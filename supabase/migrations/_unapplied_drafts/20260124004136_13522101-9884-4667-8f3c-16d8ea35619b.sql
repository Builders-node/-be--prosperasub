-- Create restaurant_admins junction table
CREATE TABLE public.restaurant_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  is_owner BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, restaurant_id)
);

-- Add created_by column to restaurants
ALTER TABLE public.restaurants 
ADD COLUMN IF NOT EXISTS created_by UUID;

-- Enable RLS on restaurant_admins
ALTER TABLE public.restaurant_admins ENABLE ROW LEVEL SECURITY;

-- RLS policies for restaurant_admins
CREATE POLICY "Users can view their own admin memberships"
ON public.restaurant_admins FOR SELECT
USING (user_id = get_current_user_id());

CREATE POLICY "Super admins can manage all admin memberships"
ON public.restaurant_admins FOR ALL
USING (has_role(get_current_user_id(), 'super_admin'::app_role));

CREATE POLICY "Restaurant owners can manage their restaurant admins"
ON public.restaurant_admins FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.restaurant_admins ra
    WHERE ra.restaurant_id = restaurant_admins.restaurant_id
    AND ra.user_id = get_current_user_id()
    AND ra.is_owner = true
  )
);

-- Migrate existing data: create admin entries from users.restaurant_id
INSERT INTO public.restaurant_admins (user_id, restaurant_id, is_owner)
SELECT id, restaurant_id, true
FROM public.users
WHERE restaurant_id IS NOT NULL
ON CONFLICT (user_id, restaurant_id) DO NOTHING;

-- Update created_by on restaurants based on existing admin links
UPDATE public.restaurants r
SET created_by = (
  SELECT u.id FROM public.users u WHERE u.restaurant_id = r.id LIMIT 1
)
WHERE created_by IS NULL;

-- Update RLS policy on restaurants to use junction table
DROP POLICY IF EXISTS "Restaurant admins can update their own restaurant" ON public.restaurants;

CREATE POLICY "Restaurant admins can update their own restaurants"
ON public.restaurants FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.restaurant_admins ra
    WHERE ra.restaurant_id = restaurants.id
    AND ra.user_id = get_current_user_id()
  )
);

-- Helper function to check if user is admin of a restaurant
CREATE OR REPLACE FUNCTION public.is_restaurant_admin(p_restaurant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.restaurant_admins
    WHERE restaurant_id = p_restaurant_id
      AND user_id = get_current_user_id()
  )
$$;

-- Function to get user's restaurants
CREATE OR REPLACE FUNCTION public.get_user_restaurants(p_user_id uuid)
RETURNS TABLE(
  id uuid,
  name text,
  description text,
  address text,
  logo_url text,
  is_active boolean,
  created_at timestamptz,
  is_owner boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    r.id,
    r.name,
    r.description,
    r.address,
    r.logo_url,
    r.is_active,
    r.created_at,
    ra.is_owner
  FROM public.restaurants r
  JOIN public.restaurant_admins ra ON ra.restaurant_id = r.id
  WHERE ra.user_id = p_user_id
  ORDER BY r.created_at DESC
$$;
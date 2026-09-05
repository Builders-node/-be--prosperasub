-- Drop existing tables that we don't need (keeping lightning_auth_sessions for Lightning login)
DROP TABLE IF EXISTS public.tournament_applications CASCADE;
DROP TABLE IF EXISTS public.login_history CASCADE;
DROP TABLE IF EXISTS public.user_roles CASCADE;

-- Create app_role enum if it doesn't exist (update to include restaurant_admin)
DO $$
BEGIN
  DROP TYPE IF EXISTS public.app_role CASCADE;
  CREATE TYPE public.app_role AS ENUM ('super_admin', 'restaurant_admin', 'user');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create meal_type enum
DO $$
BEGIN
  CREATE TYPE public.meal_type AS ENUM ('eat_in', 'delivery');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create meal_choice enum
DO $$
BEGIN
  CREATE TYPE public.meal_choice AS ENUM ('eat_in', 'delivery', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create meal_status enum
DO $$
BEGIN
  CREATE TYPE public.meal_status AS ENUM ('pending', 'prepared', 'delivered', 'completed', 'no_show');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create payment_status enum
DO $$
BEGIN
  CREATE TYPE public.payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create payment_method enum
DO $$
BEGIN
  CREATE TYPE public.payment_method AS ENUM ('lightning', 'solana');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create menu_status enum
DO $$
BEGIN
  CREATE TYPE public.menu_status AS ENUM ('draft', 'published');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create lightning_wallet_type enum
DO $$
BEGIN
  CREATE TYPE public.lightning_wallet_type AS ENUM ('lnurl', 'invoice', 'lnbits', 'other');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create day_of_week enum
DO $$
BEGIN
  CREATE TYPE public.day_of_week AS ENUM ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Modify users table to add new fields (keeping lightning_pubkey for Lightning auth)
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS email TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS password_hash TEXT,
ADD COLUMN IF NOT EXISTS name TEXT,
ADD COLUMN IF NOT EXISTS restaurant_id UUID,
ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'lightning';

-- Make lightning_pubkey nullable for email/google users
ALTER TABLE public.users ALTER COLUMN lightning_pubkey DROP NOT NULL;

-- Create user_roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, role)
);

-- Create user_profiles table for food preferences
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  food_preferences TEXT[] DEFAULT '{}',
  default_meal_type public.meal_type DEFAULT 'eat_in',
  default_delivery_address JSONB,
  phone_number TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create restaurants table
CREATE TABLE IF NOT EXISTS public.restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  logo_url TEXT,
  address TEXT,
  opening_hours JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add foreign key for restaurant_id on users
ALTER TABLE public.users 
ADD CONSTRAINT users_restaurant_id_fkey 
FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE SET NULL;

-- Create restaurant_wallets table
CREATE TABLE IF NOT EXISTS public.restaurant_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL UNIQUE REFERENCES public.restaurants(id) ON DELETE CASCADE,
  lightning_type public.lightning_wallet_type DEFAULT 'lnbits',
  lightning_identifier TEXT,
  lightning_api_key TEXT,
  solana_wallet_address TEXT,
  test_mode BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create subscription_plans table
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_per_week_sats INTEGER NOT NULL,
  price_per_week_sol NUMERIC(18, 9) NOT NULL,
  max_duration_weeks INTEGER DEFAULT 4 CHECK (max_duration_weeks >= 1 AND max_duration_weeks <= 4),
  supports_delivery BOOLEAN DEFAULT true,
  meal_time TIME NOT NULL DEFAULT '13:00',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create weekly_menus table
CREATE TABLE IF NOT EXISTS public.weekly_menus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES public.subscription_plans(id) ON DELETE SET NULL,
  week_start_date DATE NOT NULL,
  week_end_date DATE NOT NULL,
  status public.menu_status DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(restaurant_id, week_start_date)
);

-- Create menu_items table
CREATE TABLE IF NOT EXISTS public.menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  weekly_menu_id UUID NOT NULL REFERENCES public.weekly_menus(id) ON DELETE CASCADE,
  day_of_week public.day_of_week NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  duration_weeks INTEGER NOT NULL CHECK (duration_weeks >= 1 AND duration_weeks <= 4),
  total_price_sats INTEGER NOT NULL,
  total_price_sol NUMERIC(18, 9) NOT NULL,
  payment_status public.payment_status DEFAULT 'pending',
  payment_method public.payment_method,
  payment_reference TEXT,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create daily_meal_choices table
CREATE TABLE IF NOT EXISTS public.daily_meal_choices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  choice public.meal_choice,
  locked BOOLEAN DEFAULT false,
  delivery_address JSONB,
  customer_notes TEXT,
  status public.meal_status DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(subscription_id, date)
);

-- Create global_settings table
CREATE TABLE IF NOT EXISTS public.global_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  min_subscription_weeks INTEGER DEFAULT 1,
  max_subscription_weeks INTEGER DEFAULT 4,
  daily_choice_cutoff_hours INTEGER DEFAULT 3,
  platform_fee_percent NUMERIC(5, 2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default global settings
INSERT INTO public.global_settings (min_subscription_weeks, max_subscription_weeks, daily_choice_cutoff_hours, platform_fee_percent)
VALUES (1, 4, 3, 0)
ON CONFLICT DO NOTHING;

-- Enable RLS on all tables
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_meal_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;

-- Create has_role function for RLS
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Helper function to get current user ID from pubkey
CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pubkey TEXT;
  v_user_id UUID;
BEGIN
  v_pubkey := current_setting('app.current_pubkey', true);
  IF v_pubkey IS NOT NULL AND v_pubkey != '' THEN
    SELECT id INTO v_user_id FROM public.users WHERE lightning_pubkey = v_pubkey;
    RETURN v_user_id;
  END IF;
  RETURN NULL;
END;
$$;

-- RLS Policies for user_roles
CREATE POLICY "Super admins can manage all roles" ON public.user_roles
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

CREATE POLICY "Users can view their own roles" ON public.user_roles
  FOR SELECT USING (user_id = get_current_user_id());

-- RLS Policies for user_profiles
CREATE POLICY "Users can view and edit their own profile" ON public.user_profiles
  FOR ALL USING (user_id = get_current_user_id());

CREATE POLICY "Super admins can view all profiles" ON public.user_profiles
  FOR SELECT USING (has_role(get_current_user_id(), 'super_admin'));

-- RLS Policies for restaurants (public read, admin write)
CREATE POLICY "Anyone can view active restaurants" ON public.restaurants
  FOR SELECT USING (is_active = true);

CREATE POLICY "Super admins can manage all restaurants" ON public.restaurants
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

CREATE POLICY "Restaurant admins can update their own restaurant" ON public.restaurants
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id()
      AND u.restaurant_id = restaurants.id
    )
  );

-- RLS Policies for restaurant_wallets
CREATE POLICY "Super admins can manage all wallets" ON public.restaurant_wallets
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

CREATE POLICY "Restaurant admins can manage their own wallet" ON public.restaurant_wallets
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id()
      AND u.restaurant_id = restaurant_wallets.restaurant_id
    )
  );

-- RLS Policies for subscription_plans (public read)
CREATE POLICY "Anyone can view active plans" ON public.subscription_plans
  FOR SELECT USING (is_active = true);

CREATE POLICY "Super admins can manage all plans" ON public.subscription_plans
  FOR ALL USING (has_role(get_current_user_id(), 'super_admin'));

CREATE POLICY "Restaurant admins can manage their own plans" ON public.subscription_plans
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id()
      AND u.restaurant_id = subscription_plans.restaurant_id
    )
  );

-- RLS Policies for weekly_menus
CREATE POLICY "Anyone can view published menus" ON public.weekly_menus
  FOR SELECT USING (status = 'published');

CREATE POLICY "Restaurant admins can manage their own menus" ON public.weekly_menus
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id()
      AND u.restaurant_id = weekly_menus.restaurant_id
    )
  );

CREATE POLICY "Super admins can view all menus" ON public.weekly_menus
  FOR SELECT USING (has_role(get_current_user_id(), 'super_admin'));

-- RLS Policies for menu_items
CREATE POLICY "Anyone can view menu items of published menus" ON public.menu_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.weekly_menus wm
      WHERE wm.id = menu_items.weekly_menu_id
      AND wm.status = 'published'
    )
  );

CREATE POLICY "Restaurant admins can manage their own menu items" ON public.menu_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id()
      AND u.restaurant_id = menu_items.restaurant_id
    )
  );

-- RLS Policies for subscriptions
CREATE POLICY "Users can view and create their own subscriptions" ON public.subscriptions
  FOR ALL USING (user_id = get_current_user_id());

CREATE POLICY "Restaurant admins can view subscriptions to their restaurant" ON public.subscriptions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = get_current_user_id()
      AND u.restaurant_id = subscriptions.restaurant_id
    )
  );

CREATE POLICY "Super admins can view all subscriptions" ON public.subscriptions
  FOR SELECT USING (has_role(get_current_user_id(), 'super_admin'));

-- RLS Policies for daily_meal_choices
CREATE POLICY "Users can manage their own meal choices" ON public.daily_meal_choices
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.subscriptions s
      WHERE s.id = daily_meal_choices.subscription_id
      AND s.user_id = get_current_user_id()
    )
  );

CREATE POLICY "Restaurant admins can view and update meal choices for their restaurant" ON public.daily_meal_choices
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.subscriptions s
      JOIN public.users u ON u.restaurant_id = s.restaurant_id
      WHERE s.id = daily_meal_choices.subscription_id
      AND u.id = get_current_user_id()
    )
  );

CREATE POLICY "Super admins can view all meal choices" ON public.daily_meal_choices
  FOR SELECT USING (has_role(get_current_user_id(), 'super_admin'));

-- RLS Policies for global_settings
CREATE POLICY "Anyone can view global settings" ON public.global_settings
  FOR SELECT USING (true);

CREATE POLICY "Super admins can update global settings" ON public.global_settings
  FOR UPDATE USING (has_role(get_current_user_id(), 'super_admin'));

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add updated_at triggers
DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON public.user_profiles;
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_restaurants_updated_at ON public.restaurants;
CREATE TRIGGER update_restaurants_updated_at
  BEFORE UPDATE ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_restaurant_wallets_updated_at ON public.restaurant_wallets;
CREATE TRIGGER update_restaurant_wallets_updated_at
  BEFORE UPDATE ON public.restaurant_wallets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_subscription_plans_updated_at ON public.subscription_plans;
CREATE TRIGGER update_subscription_plans_updated_at
  BEFORE UPDATE ON public.subscription_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_weekly_menus_updated_at ON public.weekly_menus;
CREATE TRIGGER update_weekly_menus_updated_at
  BEFORE UPDATE ON public.weekly_menus
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_menu_items_updated_at ON public.menu_items;
CREATE TRIGGER update_menu_items_updated_at
  BEFORE UPDATE ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_daily_meal_choices_updated_at ON public.daily_meal_choices;
CREATE TRIGGER update_daily_meal_choices_updated_at
  BEFORE UPDATE ON public.daily_meal_choices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_global_settings_updated_at ON public.global_settings;
CREATE TRIGGER update_global_settings_updated_at
  BEFORE UPDATE ON public.global_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Create function to generate daily meal choices when subscription is paid
CREATE OR REPLACE FUNCTION public.generate_meal_choices_for_subscription(p_subscription_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_date DATE;
  v_end_date DATE;
  v_current_date DATE;
BEGIN
  SELECT start_date, end_date INTO v_start_date, v_end_date
  FROM public.subscriptions WHERE id = p_subscription_id;
  
  v_current_date := v_start_date;
  WHILE v_current_date <= v_end_date LOOP
    INSERT INTO public.daily_meal_choices (subscription_id, date, choice, locked, status)
    VALUES (p_subscription_id, v_current_date, NULL, false, 'pending')
    ON CONFLICT (subscription_id, date) DO NOTHING;
    v_current_date := v_current_date + 1;
  END LOOP;
END;
$$;

-- Create function to auto-lock meal choices and set default
CREATE OR REPLACE FUNCTION public.lock_overdue_meal_choices()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Lock choices where cutoff has passed and set default to eat_in if not set
  UPDATE public.daily_meal_choices dmc
  SET 
    locked = true,
    choice = COALESCE(choice, 'eat_in')
  FROM public.subscriptions s
  JOIN public.subscription_plans sp ON s.plan_id = sp.id
  JOIN public.global_settings gs ON true
  WHERE dmc.subscription_id = s.id
    AND dmc.locked = false
    AND s.is_active = true
    AND (dmc.date + sp.meal_time - (gs.daily_choice_cutoff_hours || ' hours')::interval) <= now();
END;
$$;
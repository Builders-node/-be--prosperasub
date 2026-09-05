
-- Create cleaning_packages table
CREATE TABLE public.cleaning_packages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  cleanings_per_month INTEGER NOT NULL,
  price_per_cleaning_cents INTEGER NOT NULL DEFAULT 1000,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.cleaning_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active cleaning packages"
  ON public.cleaning_packages FOR SELECT
  USING (is_active = true);

CREATE POLICY "Super admins can manage all cleaning packages"
  ON public.cleaning_packages FOR ALL
  USING (has_role(get_current_user_id(), 'super_admin'::app_role));

-- Create cleaning_available_slots table
CREATE TABLE public.cleaning_available_slots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  max_bookings INTEGER NOT NULL DEFAULT 1,
  current_bookings INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.cleaning_available_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view available cleaning slots"
  ON public.cleaning_available_slots FOR SELECT
  USING (true);

CREATE POLICY "Super admins can manage all cleaning slots"
  ON public.cleaning_available_slots FOR ALL
  USING (has_role(get_current_user_id(), 'super_admin'::app_role));

-- Create cleaning_subscriptions table
CREATE TABLE public.cleaning_subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES public.cleaning_packages(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  cleanings_remaining INTEGER NOT NULL,
  payment_status payment_status NOT NULL DEFAULT 'pending',
  payment_method payment_method NOT NULL DEFAULT 'lightning',
  payment_reference TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.cleaning_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own cleaning subscriptions"
  ON public.cleaning_subscriptions FOR SELECT
  USING (user_id = get_current_user_id());

CREATE POLICY "Users can create their own cleaning subscriptions"
  ON public.cleaning_subscriptions FOR INSERT
  WITH CHECK (user_id = get_current_user_id());

CREATE POLICY "Users can update their own cleaning subscriptions"
  ON public.cleaning_subscriptions FOR UPDATE
  USING (user_id = get_current_user_id());

CREATE POLICY "Super admins can manage all cleaning subscriptions"
  ON public.cleaning_subscriptions FOR ALL
  USING (has_role(get_current_user_id(), 'super_admin'::app_role));

-- Create cleaning_bookings table
CREATE TYPE public.cleaning_booking_status AS ENUM ('booked', 'completed', 'cancelled');

CREATE TABLE public.cleaning_bookings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES public.cleaning_subscriptions(id) ON DELETE CASCADE,
  slot_id UUID NOT NULL REFERENCES public.cleaning_available_slots(id),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status cleaning_booking_status NOT NULL DEFAULT 'booked',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.cleaning_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own cleaning bookings"
  ON public.cleaning_bookings FOR SELECT
  USING (user_id = get_current_user_id());

CREATE POLICY "Users can create their own cleaning bookings"
  ON public.cleaning_bookings FOR INSERT
  WITH CHECK (user_id = get_current_user_id());

CREATE POLICY "Users can update their own cleaning bookings"
  ON public.cleaning_bookings FOR UPDATE
  USING (user_id = get_current_user_id());

CREATE POLICY "Super admins can manage all cleaning bookings"
  ON public.cleaning_bookings FOR ALL
  USING (has_role(get_current_user_id(), 'super_admin'::app_role));

-- Seed default cleaning packages
INSERT INTO public.cleaning_packages (name, cleanings_per_month, price_per_cleaning_cents)
VALUES 
  ('4 Cleanings / Month', 4, 1000),
  ('8 Cleanings / Month', 8, 1000);

-- Create function to book a cleaning slot
CREATE OR REPLACE FUNCTION public.book_cleaning_slot(
  p_subscription_id UUID,
  p_slot_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_remaining INTEGER;
  v_max_bookings INTEGER;
  v_current_bookings INTEGER;
  v_booking_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Check subscription belongs to user and has remaining cleanings
  SELECT cs.cleanings_remaining INTO v_remaining
  FROM cleaning_subscriptions cs
  WHERE cs.id = p_subscription_id
    AND cs.user_id = v_user_id
    AND cs.is_active = true;

  IF v_remaining IS NULL THEN
    RAISE EXCEPTION 'Subscription not found or inactive';
  END IF;

  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'No cleanings remaining';
  END IF;

  -- Check slot availability
  SELECT s.max_bookings, s.current_bookings INTO v_max_bookings, v_current_bookings
  FROM cleaning_available_slots s
  WHERE s.id = p_slot_id AND s.date >= CURRENT_DATE;

  IF v_max_bookings IS NULL THEN
    RAISE EXCEPTION 'Slot not found or in the past';
  END IF;

  IF v_current_bookings >= v_max_bookings THEN
    RAISE EXCEPTION 'Slot is fully booked';
  END IF;

  -- Create booking
  INSERT INTO cleaning_bookings (subscription_id, slot_id, user_id, notes)
  VALUES (p_subscription_id, p_slot_id, v_user_id, p_notes)
  RETURNING id INTO v_booking_id;

  -- Decrement remaining cleanings
  UPDATE cleaning_subscriptions
  SET cleanings_remaining = cleanings_remaining - 1, updated_at = now()
  WHERE id = p_subscription_id;

  -- Increment slot bookings
  UPDATE cleaning_available_slots
  SET current_bookings = current_bookings + 1, updated_at = now()
  WHERE id = p_slot_id;

  RETURN v_booking_id;
END;
$$;

-- Create function to cancel a cleaning booking
CREATE OR REPLACE FUNCTION public.cancel_cleaning_booking(p_booking_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_subscription_id UUID;
  v_slot_id UUID;
  v_slot_date DATE;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Get booking details
  SELECT cb.subscription_id, cb.slot_id, cas.date
  INTO v_subscription_id, v_slot_id, v_slot_date
  FROM cleaning_bookings cb
  JOIN cleaning_available_slots cas ON cas.id = cb.slot_id
  WHERE cb.id = p_booking_id
    AND cb.user_id = v_user_id
    AND cb.status = 'booked';

  IF v_subscription_id IS NULL THEN
    RAISE EXCEPTION 'Booking not found or already cancelled';
  END IF;

  IF v_slot_date <= CURRENT_DATE THEN
    RAISE EXCEPTION 'Cannot cancel past or same-day bookings';
  END IF;

  -- Cancel booking
  UPDATE cleaning_bookings SET status = 'cancelled', updated_at = now()
  WHERE id = p_booking_id;

  -- Restore remaining cleaning
  UPDATE cleaning_subscriptions
  SET cleanings_remaining = cleanings_remaining + 1, updated_at = now()
  WHERE id = v_subscription_id;

  -- Decrement slot bookings
  UPDATE cleaning_available_slots
  SET current_bookings = GREATEST(current_bookings - 1, 0), updated_at = now()
  WHERE id = v_slot_id;

  RETURN true;
END;
$$;

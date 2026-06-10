-- Customer WhatsApp number collected at car rental booking.
ALTER TABLE public.rental_bookings ADD COLUMN IF NOT EXISTS customer_whatsapp TEXT;

-- Add new payment method enum values
ALTER TYPE public.payment_method ADD VALUE IF NOT EXISTS 'fiat';
ALTER TYPE public.payment_method ADD VALUE IF NOT EXISTS 'crypto';
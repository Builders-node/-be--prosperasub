-- Add telegram_username column to user_profiles
ALTER TABLE public.user_profiles ADD COLUMN telegram_username text;
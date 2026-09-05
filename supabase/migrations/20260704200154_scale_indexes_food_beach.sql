-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704200154 · scale_indexes_food_beach


CREATE INDEX IF NOT EXISTS idx_food_subs_user_status ON public.food_subscriptions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_food_subs_provider ON public.food_subscriptions (provider_id);
CREATE INDEX IF NOT EXISTS idx_food_subs_plan ON public.food_subscriptions (meal_plan_id);
CREATE INDEX IF NOT EXISTS idx_food_subs_end_date ON public.food_subscriptions (end_date) WHERE end_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_food_subs_payment_ref ON public.food_subscriptions (payment_reference) WHERE payment_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_food_subs_payment_pending ON public.food_subscriptions (payment_status) WHERE payment_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_beach_subs_user_status ON public.beach_club_subscriptions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_beach_subs_plan ON public.beach_club_subscriptions (plan_id);
CREATE INDEX IF NOT EXISTS idx_beach_subs_dates ON public.beach_club_subscriptions (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_beach_subs_payment_ref ON public.beach_club_subscriptions (payment_reference) WHERE payment_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_beach_subs_payment_pending ON public.beach_club_subscriptions (payment_status) WHERE payment_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_csub_payment_ref ON public.cleaning_subscriptions (payment_reference) WHERE payment_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_csub_payment_pending ON public.cleaning_subscriptions (payment_status) WHERE payment_status = 'pending';

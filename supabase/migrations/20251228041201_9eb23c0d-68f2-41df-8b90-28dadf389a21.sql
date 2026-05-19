-- Fix INSERT RLS on subscriptions: policies need WITH CHECK for INSERT

DROP POLICY IF EXISTS "Users can view and create their own subscriptions" ON public.subscriptions;

CREATE POLICY "Users can view their own subscriptions"
ON public.subscriptions
FOR SELECT
USING (user_id = public.get_current_user_id());

CREATE POLICY "Users can create their own subscriptions"
ON public.subscriptions
FOR INSERT
WITH CHECK (user_id = public.get_current_user_id());

CREATE POLICY "Users can update their own subscriptions"
ON public.subscriptions
FOR UPDATE
USING (user_id = public.get_current_user_id())
WITH CHECK (user_id = public.get_current_user_id());

CREATE POLICY "Users can delete their own subscriptions"
ON public.subscriptions
FOR DELETE
USING (user_id = public.get_current_user_id());

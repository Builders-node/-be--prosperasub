-- The read model was created SECURITY DEFINER, which means it hands back rows
-- with the view owner's rights no matter who asks — so it would keep leaking
-- every subscription even after the underlying tables are locked down.
--
-- Flipping it to security_invoker changes nothing today (the five source tables
-- are still permissive) and makes the tightening that follows actually reach it.
-- Verified: the view reads only cleaning/food/beach/rental business tables and
-- never touches public.users.

alter view public.subscriptions_unified set (security_invoker = true);

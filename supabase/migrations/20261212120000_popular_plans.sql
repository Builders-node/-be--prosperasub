-- Popular plans: which public offers people actually buy, for the "Popular"
-- block above the site footer (and the robot pages in middleware.ts).
--
-- Subscriptions are private (RLS), so the storefront cannot count them itself.
-- This function answers with a RANK only, never a count: the order of the
-- chips on the page already tells that much, and a business's sales numbers
-- stay theirs.
--
--   plan_id      a public, active top-level plan (a combination is counted
--                under the offer it belongs to — they share one page)
--   provider_id  the business selling it
--   sales_rank   1 = most bought; ties share a rank
--
-- Only paid purchases count. A plan nobody bought is not in the answer; the
-- frontend orders those after the ranked ones, so the block works the same
-- with or without this function.
--
-- Additive only: one read-only function. Roll back with
--   drop function if exists public.popular_plans();

create or replace function public.popular_plans()
returns table (plan_id uuid, provider_id uuid, sales_rank integer)
language sql
stable
security definer
set search_path = public
as $$
  with bought as (
    select coalesce(pp.parent_plan_id, pp.id) as plan_id, count(*) as n
    from public.provider_subscriptions s
    join public.provider_plans pp on pp.id = s.plan_id
    where s.payment_status = 'paid'
    group by 1
  )
  select top.id, top.provider_id, (dense_rank() over (order by b.n desc))::integer
  from bought b
  join public.provider_plans top on top.id = b.plan_id
  join public.providers p on p.id = top.provider_id
  where top.status = 'active'
    and top.visibility = 'public'
    and top.parent_plan_id is null
    and p.status = 'active'
  order by 3, top.id;
$$;

revoke all on function public.popular_plans() from public;
grant execute on function public.popular_plans() to anon, authenticated;

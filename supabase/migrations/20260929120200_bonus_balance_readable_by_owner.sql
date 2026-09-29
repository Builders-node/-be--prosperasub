-- The one number the checkout needs.
--
-- `user_credits` is service-role only and stays that way: it holds what
-- everybody has and why, and the browser has no business reading that. But a
-- checkout cannot offer "use your bonus" without knowing whether there is any,
-- and the account API that would answer it needs a deploy the platform has not
-- managed since August.
--
-- So: one function, one integer, no rows. It tells you a balance if you name a
-- user id — which anon can already read off `users` — and nothing else: not
-- what was earned, not when, not from which order. That is a smaller fact than
-- promo_quote gives away and the same shape of trade.
--
-- Spending is NOT on this honour system. bonus_spend_on_order re-reads the
-- balance server-side when the order is written, so a page that lies about
-- what it has is refused by Postgres, exactly like the promo guard.

create or replace function public.credit_balance_of(p_user_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_cents), 0)::integer
    from public.user_credits where user_id = p_user_id;
$$;

grant execute on function public.credit_balance_of(uuid) to anon, authenticated, service_role;

comment on function public.credit_balance_of(uuid) is
  'A balance and nothing else. The ledger behind it stays service-role only; spending is re-checked by bonus_spend_on_order.';

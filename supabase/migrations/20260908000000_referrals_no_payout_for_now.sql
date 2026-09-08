-- Referrals run, but they do not pay yet.
--
-- Both amounts go to zero rather than the programme being switched off,
-- because the two do different things:
--
--   referral_enabled = false  → nothing is recorded at all
--   amounts = 0               → codes work, invitations are attributed, and a
--                               friend's first paid order still marks the
--                               referral qualified — there is simply no credit
--
-- So the platform keeps learning who brings whom and whether they actually buy,
-- which is the number worth having before deciding what an invitation is worth.
-- Turning payouts on later is this one row again with a non-zero value; it is
-- deliberately not retroactive, since referrals already marked qualified were
-- earned under the no-reward offer.
--
-- referrals_qualify already guards each insert with `if reward > 0` / `if
-- welcome > 0`, so zero writes no ledger row at all rather than a row of 0
-- (which user_credits_amount_ck would refuse anyway).

update public.global_settings set value = '0'::jsonb where key = 'referral_reward_cents';
update public.global_settings set value = '0'::jsonb where key = 'referral_welcome_cents';

-- The code is a share token, and a share token nobody can read is furniture.
--
-- The account screen reads its own code through GET /account/referrals, which
-- needs a backend deploy the platform has not been able to do since 29 August.
-- Until then the browser needs to be able to read one column of its own row, or
-- the whole feature is invisible to the person it belongs to.
--
-- Safe to expose, and not by accident — a referral code is meant to be handed
-- to strangers. Using someone else's code credits THAT PERSON, so harvesting
-- codes does nothing for the harvester; there is no version of this where
-- knowing a code hurts its owner. anon already reads id, name and email off
-- this table under `users_select_all`, so this adds a public-by-design token to
-- a set that is already public rather than opening a new class of read.
--
-- Deliberately a COLUMN grant, not a table one: password_hash and
-- nwc_connection_string stay unreadable exactly as they were.

grant select (referral_code) on public.users to anon, authenticated;

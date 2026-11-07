-- "Book up to N days" is no longer a provider setting. The frontend fixes the
-- horizon at 365 days; the Nest booking engine (not redeployable right now)
-- still honours a stored value, so the stored 30s are lifted to match.
update public.providers
   set booking_settings = jsonb_set(booking_settings, '{maxAdvanceDays}', '365'::jsonb)
 where booking_settings ? 'maxAdvanceDays';

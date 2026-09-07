-- A SECURITY DEFINER function without a pinned search_path resolves unqualified
-- names against the CALLER's path, so anyone who can create a schema object can
-- shadow a table or an operator and have it run as the owner. These five were
-- the remaining definers without one.
--
-- `extensions` is included because the rental/occurrence helpers reach for
-- extension functions the same way the auth ones reach for crypt().

alter function public.auth_get_user_by_id(text)        set search_path = public, extensions;
alter function public.delete_mirrored_occurrence()     set search_path = public, extensions;
alter function public.mirror_rental_occurrences()      set search_path = public, extensions;
alter function public.notify_rental_payment_received() set search_path = public, extensions;
alter function public.mirror_rental_occurrence_one(text,uuid,uuid,text,timestamptz,text,text,text)
                                                       set search_path = public, extensions;

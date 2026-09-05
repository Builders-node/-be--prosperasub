-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810044259 · fix_provider_category_trigger_clobbering_caller_choice

-- The trigger overwrote providers.category_key on EVERY insert with
-- service_archetypes.category_key, and all four archetypes point at a category
-- that does not exist in service_categories (transport / food / home / venues).
-- Net effect: inserting any provider under any archetype failed with
--   23503 providers_category_key_fkey ... Key (category_key)=(venues) is not present
-- so creating a provider in admin, and approving a universal-only provider
-- application, were both broken outright.
--
-- Two changes, both narrowing:
--   1. Only fill category_key when the caller left it null. An explicit choice
--      is a choice; the admin UI has a category picker and it was being ignored.
--   2. Join through service_categories so the value assigned is guaranteed to
--      exist. The trigger can no longer be the cause of an FK violation — at
--      worst it leaves the column null, which the FK permits.

create or replace function public.sync_provider_category_from_archetype()
returns trigger
language plpgsql
as $function$
declare cat text;
begin
  if new.category_key is null and new.archetype_key is not null then
    select a.category_key into cat
    from public.service_archetypes a
    join public.service_categories c on c.key = a.category_key
    where a.key = new.archetype_key;
    new.category_key := cat;
  end if;
  return new;
end
$function$;

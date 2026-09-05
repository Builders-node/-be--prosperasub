-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816192954 · providers_owner_guard_invoker_rights

-- The guard has to see WHO is writing, and a SECURITY DEFINER function sees
-- its own owner instead — so the first version happily let `anon` through
-- while looking like it worked. Invoker rights (the default) make
-- `current_user` the role PostgREST switched to.
create or replace function public.providers_guard_owner_column()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.admin_user_id is not null then
      raise exception 'providers.admin_user_id is set through the API, not directly'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.admin_user_id is distinct from old.admin_user_id then
    raise exception 'providers.admin_user_id is changed through the API, not directly'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

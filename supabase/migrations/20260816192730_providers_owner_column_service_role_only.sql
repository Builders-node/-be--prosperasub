-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816192730 · providers_owner_column_service_role_only

-- `providers.admin_user_id` is what the payout and occurrence endpoints call
-- ownership. The table is permissive by design (admin CRUDs write it from the
-- browser), so before this a holder of the anon key could name themselves the
-- owner of any business — or insert a row pointing at somebody else's legacy
-- provider and draw their earnings.
--
-- Every other column stays writable from the browser; only this one is
-- reserved for the service role, which reaches it through
-- ProviderMembersService.setOwner after checking who is asking.
create or replace function public.providers_guard_owner_column()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only the PostgREST web roles are restricted. The service role, the
  -- backend's own connections and any maintenance job run as themselves.
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

drop trigger if exists providers_guard_owner_column on public.providers;

create trigger providers_guard_owner_column
  before insert or update on public.providers
  for each row execute function public.providers_guard_owner_column();

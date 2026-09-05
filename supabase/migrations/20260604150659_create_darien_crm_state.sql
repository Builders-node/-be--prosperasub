-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260604150659 · create_darien_crm_state

create schema if not exists darien_crm;

create table if not exists darien_crm.crm_state (
  id text primary key,
  state jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists darien_crm.crm_state_history (
  history_id bigserial primary key,
  state_id text not null,
  state jsonb not null,
  revision bigint not null,
  source text not null default 'crm-app',
  saved_at timestamptz not null default now()
);

create index if not exists crm_state_history_state_saved_idx
  on darien_crm.crm_state_history (state_id, saved_at desc);

alter table darien_crm.crm_state enable row level security;
alter table darien_crm.crm_state_history enable row level security;

create or replace function darien_crm.save_state(p_id text, p_state jsonb, p_source text default 'crm-app')
returns table(id text, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = darien_crm, public
as $$
declare
  next_revision bigint;
begin
  if p_id is null or length(trim(p_id)) = 0 then
    raise exception 'state id is required';
  end if;

  if jsonb_typeof(p_state) <> 'object' then
    raise exception 'state must be a json object';
  end if;

  insert into crm_state as current_state (id, state, revision, updated_at)
  values (p_id, p_state, 1, now())
  on conflict (id) do update
    set state = excluded.state,
        revision = current_state.revision + 1,
        updated_at = now()
  returning current_state.revision into next_revision;

  insert into crm_state_history (state_id, state, revision, source)
  values (p_id, p_state, next_revision, coalesce(nullif(p_source, ''), 'crm-app'));

  return query
  select current_state.id, current_state.revision, current_state.updated_at
  from crm_state current_state
  where current_state.id = p_id;
end;
$$;

grant usage on schema darien_crm to service_role;
grant select, insert, update on darien_crm.crm_state to service_role;
grant select, insert on darien_crm.crm_state_history to service_role;
grant usage, select on sequence darien_crm.crm_state_history_history_id_seq to service_role;

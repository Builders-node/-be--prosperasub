-- May this customer move this appointment, and to when?
--
-- One function rather than a rule written out in the API, because the same
-- question gets asked twice: once by the screen, to decide whether to offer a
-- "move" button and what dates to allow, and once by the endpoint that
-- actually moves it. Two copies of a policy drift, and the one that drifts is
-- always the one that enforces.
--
-- A PROVIDER moving their own day never comes through here — they have their
-- operations screen and the right to use it. This is only the customer's door.

create or replace function public.occurrence_reschedule_quote(
  p_occurrence_id uuid,
  p_new_start     timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  o        public.service_occurrences%rowtype;
  p        public.provider_plans%rowtype;
  notice   integer;
  max_moves integer;
  window_d integer;
begin
  select * into o from public.service_occurrences where id = p_occurrence_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;

  if o.status <> 'scheduled' then
    return jsonb_build_object('ok', false, 'reason', 'not-scheduled');
  end if;

  -- The policy belongs to what was sold. An occurrence with no plan behind it
  -- (a mirrored legacy visit) has no policy, and no policy means no.
  if o.plan_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no-policy');
  end if;
  select * into p from public.provider_plans where id = o.plan_id;
  if not found or not coalesce(p.reschedule_allowed, false) then
    return jsonb_build_object('ok', false, 'reason', 'not-allowed');
  end if;

  notice    := greatest(coalesce(p.reschedule_min_notice_minutes, 0), 0);
  max_moves := p.reschedule_max_per_occurrence;
  window_d  := p.reschedule_window_days;

  if now() > o.starts_at - make_interval(mins => notice) then
    return jsonb_build_object('ok', false, 'reason', 'too-late',
                              'min_notice_minutes', notice);
  end if;

  if max_moves is not null and coalesce(o.reschedule_count, 0) >= max_moves then
    return jsonb_build_object('ok', false, 'reason', 'too-many',
                              'max_per_occurrence', max_moves);
  end if;

  -- Without a proposed time this is the "may I at all?" question, which the
  -- screen asks before it draws anything.
  if p_new_start is null then
    return jsonb_build_object('ok', true, 'min_notice_minutes', notice,
                              'window_days', window_d,
                              'moves_left', case when max_moves is null then null
                                                 else max_moves - coalesce(o.reschedule_count, 0) end);
  end if;

  if p_new_start <= now() then
    return jsonb_build_object('ok', false, 'reason', 'in-the-past');
  end if;
  if window_d is not null and p_new_start > o.starts_at + make_interval(days => window_d) then
    return jsonb_build_object('ok', false, 'reason', 'too-far', 'window_days', window_d);
  end if;

  return jsonb_build_object('ok', true, 'new_start', p_new_start,
                            'min_notice_minutes', notice, 'window_days', window_d);
end $$;

-- Service-role only: service_occurrences holds addresses and access
-- instructions, and this reads a row of it. The customer's screen reaches it
-- through the account API, which knows whose occurrence it is.
revoke execute on function public.occurrence_reschedule_quote(uuid,timestamptz) from public, anon, authenticated;
grant  execute on function public.occurrence_reschedule_quote(uuid,timestamptz) to service_role;

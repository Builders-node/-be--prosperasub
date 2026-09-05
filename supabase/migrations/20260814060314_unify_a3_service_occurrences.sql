-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060314 · unify_a3_service_occurrences

-- One occurrence table for every fulfilment shape: a cleaning visit, a meal
-- delivery, an hour on a court. Cleaning and the beach already have these
-- under their own names; food has only a log of what went wrong, which is the
-- actual reason it has no reschedule, no assignee and no completion report.
--
-- Nothing writes this yet — phase B dual-writes, phase C reads.
create table if not exists service_occurrences (
  id uuid primary key default gen_random_uuid(),

  subscription_id uuid,
  provider_id     uuid not null,
  plan_id         uuid,
  resource_id     uuid,
  user_id         uuid,

  -- "visit 3 of 12"; and which deliverable this row is, when one occasion has
  -- several (breakfast / lunch / dinner on the same delivery date)
  sequence int,
  item_key text,

  starts_at timestamptz not null,
  ends_at   timestamptz,
  slot_id   uuid,

  status        text not null default 'scheduled',
  status_reason text,

  assignee            text,
  notes               text,
  access_instructions text,

  -- { checklist, photo_url, issue, completed_by, completed_at }
  completion jsonb,

  google_calendar_event_id   text,
  google_calendar_sync_status text,
  google_calendar_sync_error  text,

  -- a move keeps its history rather than overwriting the old time
  rescheduled_from uuid references service_occurrences(id),

  -- while both models run, this says which legacy row this mirrors
  source_service_key text,
  source_record_id   text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table service_occurrences drop constraint if exists service_occurrences_status_check;
alter table service_occurrences add constraint service_occurrences_status_check
  check (status in ('scheduled', 'done', 'failed', 'cancelled', 'rescheduled'));

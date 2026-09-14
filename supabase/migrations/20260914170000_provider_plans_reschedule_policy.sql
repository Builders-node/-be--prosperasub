-- Whether a customer may move an appointment, and on what terms.
--
-- A plan already says how it is sold and how it is fulfilled — visits,
-- deliveries, hours on a calendar. What it never said is what happens when the
-- customer cannot make one. The only way to move a visit was to ask the
-- provider, who moves it from their own operations screen; the customer had no
-- door at all, and the provider no way to say "yes, but give me a day's
-- notice, and twice at most".
--
-- Stated on the PLAN rather than on the business, because it is a property of
-- what was sold: a weekly cleaning and a booked tennis hour do not deserve the
-- same answer, and one business may sell both.

alter table public.provider_plans
  add column if not exists reschedule_allowed boolean not null default false;

-- How long before it starts the customer may still move it. NULL means "any
-- time before it starts"; the guard treats 0 and NULL the same way.
alter table public.provider_plans
  add column if not exists reschedule_min_notice_minutes integer;

-- How many times ONE occurrence may be moved. Not per period: a customer who
-- keeps pushing the same visit a day at a time is the case this bounds, and
-- counting it per occurrence is what makes that countable at all.
alter table public.provider_plans
  add column if not exists reschedule_max_per_occurrence integer;

-- How far ahead it may be moved to, in days. Stops a cleaning bought for
-- September being parked in December.
alter table public.provider_plans
  add column if not exists reschedule_window_days integer;

comment on column public.provider_plans.reschedule_allowed is
  'Whether the CUSTOMER may move an occurrence themselves. A provider can always move one from their own screen; this is about the customer''s door.';

alter table public.service_occurrences
  add column if not exists reschedule_count integer not null default 0;

comment on column public.service_occurrences.reschedule_count is
  'How many times this occurrence has been moved. rescheduled_from remembers only the last move, which cannot answer how many.';

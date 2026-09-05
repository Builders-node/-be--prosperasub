-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810233957 · cleaning_slots_per_provider

-- The slot grid was global and its four time pairs were hard-coded inside
-- seed_cleaning_slots itself:
--   ('08:00','09:45'), ('10:00','11:45'), ('12:00','13:45'), ('14:00','15:45')
-- so every cleaning provider got 105-minute slots no matter what it was set to.
-- Car Wash is configured sessionDurationMin = 60 and still offered 8:00–9:45.
-- providers.booking_settings was read by the booking page only as a FILTER —
-- it could hide a slot outside opening hours, but never change its length.
--
-- Slots become per-provider. Existing rows keep provider_id NULL and mean the
-- same thing they mean today: the shared grid. Nothing already booked moves,
-- and a provider keeps using the shared grid until it has slots of its own.

alter table cleaning_available_slots
  add column if not exists provider_id uuid references providers(id) on delete cascade;

comment on column cleaning_available_slots.provider_id is
  'Which provider this slot belongs to. NULL = the legacy shared grid, still used by any provider with no slots of its own.';

-- The old uniqueness was (date, start_time, end_time), which stopped two
-- providers from ever offering the same hour. NULLs compare as distinct in a
-- plain unique index, so the legacy rows are coalesced to a sentinel instead.
drop index if exists cleaning_available_slots_date_start_end_key;
alter table cleaning_available_slots
  drop constraint if exists cleaning_available_slots_date_start_time_end_time_key;

create unique index if not exists cleaning_available_slots_provider_slot_uniq
  on cleaning_available_slots (
    date, start_time, end_time,
    coalesce(provider_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index if not exists cleaning_available_slots_provider_date_idx
  on cleaning_available_slots (provider_id, date) where is_active;

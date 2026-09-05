-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804211649 · create_support_messages

-- Customer support: a customer sends one message, an admin reads it in the
-- panel and replies out of band (email / WhatsApp). Deliberately NOT a
-- threaded ticket system — no replies are stored, so nothing here pretends to
-- be a conversation the customer can come back to.
create table if not exists public.support_messages (
  id           uuid primary key default gen_random_uuid(),
  -- Null for a signed-out sender; the name/email fields are what we reply to.
  user_id      uuid,
  name         text not null,
  email        text not null,
  phone        text,
  subject      text not null,
  message      text not null,
  -- Where they were when they hit Send: saves the admin asking "which page?".
  page_url     text,
  -- new → an admin has looked → dealt with. Not a ticket lifecycle, just a
  -- read/handled marker so the inbox can be worked through.
  status       text not null default 'new',
  admin_notes  text,
  handled_by   uuid,
  handled_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists support_messages_status_created_idx
  on public.support_messages (status, created_at desc);
create index if not exists support_messages_user_idx
  on public.support_messages (user_id);

alter table public.support_messages enable row level security;

-- Reads are admin-only: these rows carry a name, an email and whatever the
-- customer chose to write. Writes go through the backend with the service
-- role, so no public insert policy is needed either.
drop policy if exists support_messages_service_role on public.support_messages;
create policy support_messages_service_role on public.support_messages
  for all to service_role using (true) with check (true);

comment on table public.support_messages is
  'Inbound customer support messages. One-way: replies happen over email/WhatsApp, not in the app. Service-role only — the rows contain contact details.';

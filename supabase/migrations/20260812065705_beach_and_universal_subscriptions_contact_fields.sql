-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812065705 · beach_and_universal_subscriptions_contact_fields

-- Two of the six checkouts asked the customer for nothing but their money.
--
-- Cleaning and food collect a WhatsApp number and a note; the cart and a car
-- booking collect both too. The beach membership and the universal plan
-- checkout collected neither — so somebody buying a membership had no way to
-- say "I'm coming with a child" and the provider had no way to reach them,
-- while the very same person buying a cleaning got both fields.
--
-- Same column names as cleaning_subscriptions and food_subscriptions
-- (customer_whatsapp / notes) rather than a new spelling: every provider-facing
-- list, export and reminder already knows those two.

alter table beach_club_subscriptions add column if not exists customer_whatsapp text;
alter table beach_club_subscriptions add column if not exists notes text;

alter table provider_subscriptions   add column if not exists customer_whatsapp text;
alter table provider_subscriptions   add column if not exists notes text;

comment on column beach_club_subscriptions.customer_whatsapp is
  'How the provider reaches this customer. Same field as cleaning_subscriptions.customer_whatsapp.';
comment on column beach_club_subscriptions.notes is
  'Anything the customer wanted the provider to know at checkout.';
comment on column provider_subscriptions.customer_whatsapp is
  'How the provider reaches this customer. Same field as cleaning_subscriptions.customer_whatsapp.';
comment on column provider_subscriptions.notes is
  'Anything the customer wanted the provider to know at checkout.';

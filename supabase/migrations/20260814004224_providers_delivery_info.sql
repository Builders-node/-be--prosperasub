-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814004224 · providers_delivery_info

alter table providers add column if not exists delivery_info text;

update providers p
set delivery_info = f.delivery_info
from food_providers f
where p.source_service_key = 'food'
  and p.source_provider_id::text = f.id::text
  and p.delivery_info is null
  and coalesce(f.delivery_info, '') <> '';

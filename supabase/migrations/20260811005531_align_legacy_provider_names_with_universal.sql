-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811005531 · align_legacy_provider_names_with_universal

-- The same business had two names. The universal row — the one customers see
-- on the listing — said "Apartment Cleaning" and "Car Wash"; the legacy row
-- still said "ProsperaSub Cleaning" and "ProsperaSub Car Wash", carrying a
-- brand the platform stopped using. Which name a person saw depended on which
-- table the page they opened happened to read.
--
-- The universal name wins: it is the one shown to customers and the one an
-- admin edits in /admin/marketplace/providers.

update cleaning_providers cp
set name = pr.name, updated_at = now()
from providers pr
where pr.source_service_key = 'cleaning'
  and pr.source_provider_id = cp.id
  and cp.name is distinct from pr.name;

update food_providers fp
set name = pr.name, updated_at = now()
from providers pr
where pr.source_service_key = 'food'
  and pr.source_provider_id = fp.id
  and fp.name is distinct from pr.name;

update rental_providers rp
set name = pr.name, updated_at = now()
from providers pr
where pr.source_service_key = 'cars'
  and pr.source_provider_id = rp.id
  and rp.name is distinct from pr.name;

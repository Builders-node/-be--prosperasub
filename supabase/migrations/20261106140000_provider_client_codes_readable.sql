-- Applied 20261106140000 · provider_client_codes_readable
--
-- The generator cut names at ten letters (ELIASCUISI, ADASTRACLI). These codes
-- are said aloud and printed under a QR, so the clipped ones get a readable
-- name. Nothing had been printed or claimed with the old ones yet.
update public.providers p set client_code = v.code
from (values
  ('Ad Astra Clinic', 'ADASTRACLI', 'ADASTRA'),
  ('Apartment Cleaning', 'APARTMENTC', 'CLEANING'),
  ('Elias Cuisine', 'ELIASCUISI', 'ELIAS'),
  ('CC Print & Design', 'CCPRINTDES', 'CCPRINT'),
  ('Roatan Fruit Dealer', 'ROATANFRUI', 'FRUITDEALER'),
  ('Roatan Island Brewing Company', 'ROATANISLA', 'ISLANDBREW'),
  ('Roatan Provision', 'ROATANPROV', 'PROVISION'),
  ('Roatan Yacht Club Divers', 'ROATANYACH', 'YACHTCLUB'),
  ('Spirit Origin Coffee', 'SPIRITORIG', 'SPIRIT'),
  ('Sun Water Company', 'SUNWATERCO', 'SUNWATER')
) as v(name, old_code, code)
where p.name = v.name and p.client_code = v.old_code
  and not exists (select 1 from public.users u where upper(u.referral_code) = v.code)
  and not exists (select 1 from public.provider_clients c where c.provider_id = p.id);

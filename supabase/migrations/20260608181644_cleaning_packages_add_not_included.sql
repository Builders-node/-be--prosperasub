-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260608181644 · cleaning_packages_add_not_included

ALTER TABLE public.cleaning_packages
  ADD COLUMN IF NOT EXISTS not_included JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Seed Studio Apartment
UPDATE public.cleaning_packages SET
  features = '["Full studio cleaning","Kitchen: counters, sink & stovetop","Bathroom: toilet, sink & shower","Floors – mopping & sweeping","Dusting all surfaces","Trash removal","Dishwashing","General tidying & organization"]'::jsonb,
  not_included = '["Laundry or folding clothes","Inside oven or refrigerator","Window cleaning","Specialized services unless requested"]'::jsonb
WHERE id = 'pkg-standard';

-- Seed 1 Bedroom Apartment
UPDATE public.cleaning_packages SET
  features = '["Full apartment cleaning","Kitchen: counters, sink & stovetop","Bathroom: toilet, sink & shower","Bedroom dusting & tidying","Floors – mopping & sweeping","Dusting all surfaces","Trash removal","Dishwashing","General organization"]'::jsonb,
  not_included = '["Laundry or folding clothes","Inside oven or refrigerator","Window cleaning","Specialized services unless requested"]'::jsonb
WHERE name = '1 Bedroom Apartment';

-- Seed 2 Bedroom Apartment (deep clean tier)
UPDATE public.cleaning_packages SET
  features = '["Full apartment cleaning (2 bedrooms)","Kitchen: counters, sink, stovetop & inside microwave","Bathroom: toilet, sink & shower (deep scrub)","All bedrooms dusted & tidied","Floors – mopping & sweeping","Dusting all surfaces & fixtures","Trash removal","Dishwashing","Inside refrigerator","Window cleaning (interior)","General organization"]'::jsonb,
  not_included = '["Laundry or folding clothes","Exterior window cleaning","Specialized or add-on services unless pre-arranged"]'::jsonb
WHERE id = 'pkg-deep';

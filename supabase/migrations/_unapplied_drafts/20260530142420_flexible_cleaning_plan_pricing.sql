ALTER TABLE public.cleaning_packages
  ADD COLUMN IF NOT EXISTS frequency_unit text NOT NULL DEFAULT 'month',
  ADD COLUMN IF NOT EXISTS frequency_count integer,
  ADD COLUMN IF NOT EXISTS custom_frequency_label text,
  ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'price_per_cleaning',
  ADD COLUMN IF NOT EXISTS monthly_price_cents integer;

ALTER TABLE public.cleaning_packages
  ALTER COLUMN price_per_cleaning_cents DROP NOT NULL;

UPDATE public.cleaning_packages
SET
  frequency_unit = COALESCE(NULLIF(frequency_unit, ''), 'month'),
  frequency_count = COALESCE(frequency_count, cleanings_per_month),
  monthly_price_cents = COALESCE(monthly_price_cents, price_per_cleaning_cents * cleanings_per_month),
  pricing_mode = COALESCE(NULLIF(pricing_mode, ''), 'price_per_cleaning')
WHERE true;

ALTER TABLE public.cleaning_packages
  DROP CONSTRAINT IF EXISTS cleaning_packages_frequency_unit_check,
  DROP CONSTRAINT IF EXISTS cleaning_packages_pricing_mode_check,
  DROP CONSTRAINT IF EXISTS cleaning_packages_frequency_count_check,
  DROP CONSTRAINT IF EXISTS cleaning_packages_custom_frequency_label_check;

ALTER TABLE public.cleaning_packages
  ADD CONSTRAINT cleaning_packages_frequency_unit_check
    CHECK (frequency_unit IN ('day', 'week', 'month', 'custom')),
  ADD CONSTRAINT cleaning_packages_pricing_mode_check
    CHECK (pricing_mode IN ('fixed_monthly_price', 'price_per_cleaning', 'calculated_estimate', 'custom_manual')),
  ADD CONSTRAINT cleaning_packages_frequency_count_check
    CHECK (frequency_unit = 'custom' OR COALESCE(frequency_count, 0) > 0),
  ADD CONSTRAINT cleaning_packages_custom_frequency_label_check
    CHECK (frequency_unit <> 'custom' OR length(trim(COALESCE(custom_frequency_label, ''))) > 0);

ALTER TABLE public.cleaning_custom_plans
  ADD COLUMN IF NOT EXISTS frequency_unit text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS frequency_count integer,
  ADD COLUMN IF NOT EXISTS custom_frequency_label text,
  ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'custom_manual',
  ADD COLUMN IF NOT EXISTS monthly_price_cents integer,
  ADD COLUMN IF NOT EXISTS price_per_cleaning_cents integer;

UPDATE public.cleaning_custom_plans
SET
  frequency_unit = COALESCE(NULLIF(frequency_unit, ''), 'custom'),
  custom_frequency_label = COALESCE(NULLIF(custom_frequency_label, ''), NULLIF(service_frequency, ''), 'Custom schedule'),
  pricing_mode = COALESCE(NULLIF(pricing_mode, ''), 'custom_manual'),
  monthly_price_cents = COALESCE(monthly_price_cents, custom_price_cents, estimated_monthly_total_cents)
WHERE true;

ALTER TABLE public.cleaning_custom_plans
  DROP CONSTRAINT IF EXISTS cleaning_custom_plans_frequency_unit_check,
  DROP CONSTRAINT IF EXISTS cleaning_custom_plans_pricing_mode_check,
  DROP CONSTRAINT IF EXISTS cleaning_custom_plans_frequency_count_check,
  DROP CONSTRAINT IF EXISTS cleaning_custom_plans_custom_frequency_label_check;

ALTER TABLE public.cleaning_custom_plans
  ADD CONSTRAINT cleaning_custom_plans_frequency_unit_check
    CHECK (frequency_unit IN ('day', 'week', 'month', 'custom')),
  ADD CONSTRAINT cleaning_custom_plans_pricing_mode_check
    CHECK (pricing_mode IN ('fixed_monthly_price', 'price_per_cleaning', 'calculated_estimate', 'custom_manual')),
  ADD CONSTRAINT cleaning_custom_plans_frequency_count_check
    CHECK (frequency_unit = 'custom' OR COALESCE(frequency_count, 0) > 0),
  ADD CONSTRAINT cleaning_custom_plans_custom_frequency_label_check
    CHECK (frequency_unit <> 'custom' OR length(trim(COALESCE(custom_frequency_label, ''))) > 0);

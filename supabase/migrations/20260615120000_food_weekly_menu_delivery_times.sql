-- Per-meal delivery times for weekly menus.
-- Stored as JSONB keyed by meal type (breakfast/lunch/dinner/…) → "HH:MM" string,
-- e.g. {"breakfast": "08:00", "lunch": "12:00", "dinner": "18:00"}.
ALTER TABLE food_weekly_menus
  ADD COLUMN IF NOT EXISTS delivery_times jsonb NOT NULL DEFAULT '{}'::jsonb;
